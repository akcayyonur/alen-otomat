// Syntec Edge Agent - surekli calisan veri toplayici.
//
// Probe'dan farki: probe tek seferlik saha teshis araci (60 sn oku, CSV yaz,
// cik). Bu ise uretim servisi - acik kalir, tum tezgahlari surekli okur,
// kopan baglantiyi yeniden kurar ve backend kapaliyken veriyi tamponlar.
//
// Mimari siniri: DLL'ler BURADA kalir. Backend'e yalnizca HTTP uzerinden duz
// JSON gider; backend hangi marka panel oldugunu bilmez (Bolum 02/05).
//
//   [Tezgah] --RemoteAPI--> [bu ajan + Syntec dll'leri] --HTTP JSON--> [backend]
//
// Her tezgah KENDI IS PARCACIGINDA okunur: bir kontrolcu yanit vermedigi zaman
// cagri saniyelerce bloke olabilir, sirayla okunsa bir tezgah digerlerini
// geciktirirdi.
//
// Hedef: .NET Framework 4.0 / C# 4.0 (csc.exe v4.0.30319).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Syntec.Telemetri;

// Surum bilgisi: dosyanin ozelliklerinde yayinci/urun/aciklama gorunsun.
[assembly: AssemblyTitle("CNC Telemetri Edge Agent")]
[assembly: AssemblyDescription("Syntec kontrolcusunden uretim verisi okuyup CNC Telemetri backend'ine gonderir")]
[assembly: AssemblyCompany("alen-otomat")]
[assembly: AssemblyProduct("CNC Telemetri")]
[assembly: AssemblyVersion("0.1.5.0")]
[assembly: AssemblyFileVersion("0.1.5.0")]

/// Console.Out'u hem konsola hem dosyaya yazar (--log).
///
/// Servis olarak acilista cikti bir dosyaya gitmeli. Bunu `cmd /c "ajan >> log
/// 2>&1"` sarmalayicisiyla yapmak Gorev Zamanlayici'ya fazladan bir kabuk
/// katmani ekliyordu ve guvenlik yazilimlari bu zinciri (gorev -> cmd ->
/// program, URL'li arguman, dosyaya yonlendirme) supheli bulabiliyor. Gunlugu
/// programin kendisi yazinca gorev dogrudan programi calistirir.
///
/// Dosya 5 MB'i asinca .1'e tasinir (eskisi silinir): servis aylarca acik
/// kalinca disk dolmasin.
class DosyaYazici : TextWriter
{
    const long Sinir = 5 * 1024 * 1024;

    readonly TextWriter _konsol;
    readonly string _yol;
    readonly object _kilit = new object();
    long _boyut;

    public DosyaYazici(TextWriter konsol, string yol)
    {
        _konsol = konsol;
        _yol = Path.GetFullPath(yol);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_yol));
            if (File.Exists(_yol)) _boyut = new FileInfo(_yol).Length;
        }
        catch { /* yazamazsak konsola yazmaya devam ederiz */ }
    }

    public override Encoding Encoding { get { return Encoding.UTF8; } }

    public override void Write(char value) { Yaz(value.ToString()); }
    public override void Write(string value) { Yaz(value); }
    public override void Write(char[] buffer, int index, int count) { Yaz(new string(buffer, index, count)); }
    public override void WriteLine(string value) { Yaz(value + Environment.NewLine); }

    void Yaz(string metin)
    {
        if (string.IsNullOrEmpty(metin)) return;
        // Servis olarak calisirken konsol olmayabilir: orada hata dosyayi etkilemesin.
        try { _konsol.Write(metin); } catch { }
        lock (_kilit)
        {
            try
            {
                if (_boyut > Sinir) Dondur();
                File.AppendAllText(_yol, metin, Encoding.UTF8);
                _boyut += metin.Length;
            }
            catch { /* disk dolu / kilitli: veri akisini durdurma */ }
        }
    }

    void Dondur()
    {
        try
        {
            string eski = _yol + ".1";
            if (File.Exists(eski)) File.Delete(eski);
            File.Move(_yol, eski);
        }
        catch { }
        _boyut = 0;
    }
}

static class Agent
{
    static string IngestUrl;
    static string DllYolu;
    static int AralikMs;
    static int YenidenDenemeMs;

    /// Backend'e gonderilmeyi bekleyen mesajlar.
    static readonly List<string> Tampon = new List<string>();
    static readonly object TamponKilit = new object();
    /// Backend uzun sure kapaliysa bellek sismesin - en eskiler dusurulur.
    const int TamponSiniri = 20000;

    static volatile bool Calisiyor = true;
    static long ToplamOkunan, ToplamGonderilen, ToplamDusen;

    class Tezgah
    {
        public string Id;
        public string Host;
        public SyntecReader Okuyucu;
        public bool Bagli;
        public DateTime SonBasari;
        public string SonHata;
        public long Okunan;
        /// Tezgah yapilandirmadan cikarildi - kendi dongusu kapansin.
        public volatile bool Dur;
        /// Kac okuma cevap vermeden takildi. Tek bir basarili okumada SIFIRLANMAZ: "birkac
        /// okuma sonra takil" dongusu surekli tekrarlanirsa sayac sinira varmali. Tezgah 5 dk
        /// kesintisiz saglikli okuyunca sifirlanir.
        public int TakiliSayisi;
        public DateTime SonTakilma;
        /// Okuma "basarili" dondu ama icerik gecersiz (ornegin Status bos); null = sorun yok.
        public volatile string YanitSorunu;
        /// Art arda kac kez yeniden baglanildi (geri cekilme icin); basarili baglantida sifirlanir.
        public int YenidenSayisi;
    }

    /// Oturumu arka planda, ZAMAN ASIMIYLA kapatir. Sunucu cevap vermiyorsa Close() de
    /// bekleyebilir; dongumuz onunla takilmasin. Takilirsa is parcacigi terk edilir.
    ///
    /// NEDEN SART: Syntec kutuphanesi oturumu yalnizca Close()/Dispose() ile kapatir; nesneyi
    /// birakmak tornada oturumu ACIK birakir. Her yeniden baglanmada bir oturum sizarsa
    /// tornanin API sunucusu zamanla tikanir (probe tek oturum acar, bu yuzden buna takilmaz).
    static void KapatArkaPlanda(SyntecReader r, int ms)
    {
        if (r == null) return;
        Thread k = new Thread(delegate() { try { r.Kapat(); } catch { } });
        k.IsBackground = true;
        k.Name = "kapat";
        k.Start();
        if (!k.Join(ms))
            Console.WriteLine("[ajan] eski oturum " + (ms / 1000) + " sn icinde kapanmadi, birakildi");
    }

    /// Yeniden baglanma bekleme suresi: her basarisizlikta ikiye katlanir (10 -> 20 -> 40 -> 60 sn).
    /// Sik denemek hem tornaya yuk bindirir hem de oturum sizdirir.
    static int GeriCekilmeMs(int deneme)
    {
        int tavan = Math.Max(60000, YenidenDenemeMs);
        int ms = YenidenDenemeMs;
        for (int i = 1; i < deneme && ms < tavan; i++) ms *= 2;
        return Math.Min(ms, tavan);
    }

    /// Kapanirken TUM oturumlari duzgun kapatir; torna tarafinda acik oturum kalmasin.
    static void KapatHepsi()
    {
        Tezgah[] hepsi;
        lock (TezgahKilit) hepsi = Tezgahlar.ToArray();
        List<Thread> isler = new List<Thread>();
        foreach (Tezgah t in hepsi)
        {
            if (t.Dur) continue; // kendi dongusu zaten kapatti
            SyntecReader r = t.Okuyucu;
            Thread k = new Thread(delegate() { try { r.Kapat(); } catch { } });
            k.IsBackground = true;
            k.Start();
            isler.Add(k);
        }
        DateTime son = DateTime.Now.AddSeconds(4);
        foreach (Thread k in isler)
        {
            int kalan = (int)(son - DateTime.Now).TotalMilliseconds;
            if (kalan <= 0 || !k.Join(kalan)) break;
        }
    }

    /// Bir Syntec okumasi bu sureden uzun surerse TAKILDI sayilir. Cagrilar native koda
    /// iner ve cevap hic gelmezse sonsuza dek bekleyebilir; zaman asimi olmazsa ajan
    /// "bagli" gorunur ama hicbir sey okumaz ve hata da yazmaz (sahada yasandi: tornanin
    /// PC'ye geri baglantisi kurulamayinca ilk birkac okumadan sonra cagri takildi).
    static int OkumaZamanAsimiMs = 15000;
    /// Takilan cagrinin is parcacigi oldurulemez, terk edilir. Bir tezgahta bu kadar takilma
    /// olursa yenisini acmayiz: sizinti birikmesin.
    ///
    /// SAYI 3 OLMALI (5 degil): torna API sunucusu ayni anda EN FAZLA 4 OTURUM tasir (simulatorde
    /// olculdu; her oturum 5566/5568/5570/5572'ye birer baglanti = 4 TCP). Takilan oturum
    /// kapanmazsa yuvasini isgal eder; 3'ten sonra yenisini acmak son yuvayi da yer ve sunucuyu
    /// BASKA istemcilere (probe, ikinci ajan) de kapatir.
    const int MaksTakili = 3;

    static readonly List<Tezgah> Tezgahlar = new List<Tezgah>();
    static readonly object TezgahKilit = new object();
    /// Tezgah listesi backend'den geliyorsa adresi; yerel dosyadan geliyorsa null.
    static string ListeUrl;
    /// Son liste istegi basarili oldu mu (bos liste de basaridir). Basarisizken
    /// liste sik denenir; her denemede ayni uyariyi tekrar basmamak icin de kullanilir.
    static volatile bool ListeSonBasarili;

    static int Main(string[] argv)
    {
        Dictionary<string, string> arg = Args(argv);

        if (arg.ContainsKey("help") || arg.ContainsKey("h"))
        {
            Yardim();
            return 0;
        }

        // --log: cikti dosyaya da yazilir (servis olarak calisirken kabuk
        // yonlendirmesi yerine). Baslik satirlari dahil her sey loglansin diye
        // ilk yazimdan once kurulur.
        string logYolu = Get(arg, "log", null);
        if (logYolu != null) Console.SetOut(new DosyaYazici(Console.Out, logYolu));

        // Beklenmeyen bir cokus sessizce kaybolmasin: gorevde konsol yok, iz kalmaz.
        AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e)
        {
            Console.WriteLine("[ajan] KRITIK HATA: " + e.ExceptionObject);
        };

        IngestUrl = Get(arg, "ingest", "http://127.0.0.1:3000/api/ingest");
        DllYolu = Get(arg, "dll", "Syntec.RemoteCNC.Win32.dll");
        AralikMs = int.Parse(Get(arg, "interval", "1000"));
        YenidenDenemeMs = int.Parse(Get(arg, "retry", "10000"));
        OkumaZamanAsimiMs = int.Parse(Get(arg, "read-timeout", "15000"));
        // Test icin: N saniye sonra kendiliginden duzgun kapan (Ctrl+C ile ayni yol).
        int sure = int.Parse(Get(arg, "duration", "0"));
        if (sure > 0)
        {
            Thread sayac = new Thread(delegate()
            {
                Thread.Sleep(sure * 1000);
                Console.WriteLine("[ajan] --duration doldu, kapaniyor");
                Calisiyor = false;
            });
            sayac.IsBackground = true;
            sayac.Start();
        }
        string makineDosyasi = Get(arg, "machines", "machines.txt");

        Console.WriteLine("=== Syntec Edge Agent ===");
        Console.WriteLine("ingest    : " + IngestUrl);
        Console.WriteLine("dll       : " + DllYolu);
        Console.WriteLine("aralik    : " + AralikMs + " ms");
        Console.WriteLine();

        // Ctrl+C: tamponu bosalt, sonra cik. Tezgah listesini beklerken de
        // calismali, bu yuzden MakineleriYukle'den ONCE kurulur.
        Console.CancelKeyPress += delegate(object s, ConsoleCancelEventArgs e)
        {
            e.Cancel = true;
            Console.WriteLine();
            Console.WriteLine("[ajan] kapaniyor, tampon bosaltiliyor...");
            Calisiyor = false;
        };

        if (!MakineleriYukle(makineDosyasi, arg))
        {
            return 1;
        }

        Tezgah[] ilk;
        lock (TezgahKilit) ilk = Tezgahlar.ToArray();
        foreach (Tezgah t in ilk) IsParcacigiBaslat(t);

        var gonderici = new Thread(GondericiDongusu);
        gonderici.IsBackground = true;
        gonderici.Name = "gonderici";
        gonderici.Start();

        DurumDongusu();

        // Kapanirken once tum Syntec oturumlarini duzgun kapat: Ctrl+C / gorev durdurma
        // tornada "olu" (acik ama sahipsiz) oturum birakmasin.
        KapatHepsi();

        // Kapanirken kalan tamponu gondermeyi dene.
        Gonder();
        Console.WriteLine("[ajan] okunan " + ToplamOkunan + ", gonderilen " + ToplamGonderilen +
                          ", dusen " + ToplamDusen);
        SertCikis(0);
        return 0;
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    static extern bool TerminateProcess(IntPtr surec, uint cikisKodu);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    /// Sureci HEMEN sonlandirir. Syntec kutuphanesi normal cikista (finalizer / native
    /// temizlik) saatlerce kilitlenebiliyor: probe, saglikli tornada bile islemini bitirip
    /// 5 dk "calisiyor" kaldi ve Ctrl+C ile olmedi. Her sey (oturumlar, tampon, log) zaten
    /// kapatildiktan sonra cagrilir; geriye beklenecek bir sey yok.
    static void SertCikis(int kod)
    {
        try { Console.Out.Flush(); } catch { }
        TerminateProcess(GetCurrentProcess(), (uint)kod);
    }

    /// Tezgah listesi, su siraya gore:
    ///   1. --host         tek tezgah (teshis icin)
    ///   2. machines.txt   yerel dosya (backend'e ulasilamayan kurulumlar)
    ///   3. backend        VARSAYILAN - ayarlar ekraninin yazdigi liste
    ///
    /// Varsayilanin backend olmasinin sebebi: tezgah tanimlarinin TEK gercek
    /// kaynagi config/machines.json olmali. Ajan kendi kopyasini tutarsa
    /// arayuzden tezgah eklendiginde ajan haberdar olmaz, ikisi ayrisir.
    static bool MakineleriYukle(string dosya, Dictionary<string, string> arg)
    {
        string tekHost = Get(arg, "host", null);
        if (tekHost != null)
        {
            Ekle(Get(arg, "machine-id", "CNC-01"), tekHost);
        }
        else if (File.Exists(dosya))
        {
            foreach (string ham in File.ReadAllLines(dosya))
            {
                string satir = ham.Trim();
                if (satir.Length == 0 || satir.StartsWith("#")) continue;
                string[] p = satir.Split(new[] { '=', ',', ';' }, 2);
                if (p.Length != 2)
                {
                    Console.WriteLine("[ajan] satir atlandi (CNC-01=192.168.1.101 bekleniyor): " + satir);
                    continue;
                }
                Ekle(p[0].Trim(), p[1].Trim());
            }
        }
        else
        {
            ListeUrl = ListeAdresi(IngestUrl);
            Console.WriteLine("[ajan] tezgah listesi backend'den aliniyor:");
            Console.WriteLine("       " + ListeUrl);

            // Bu bir SERVIS: bilgisayar acilisinda backend'den ONCE baslayabilir,
            // ya da henuz hicbir tezgaha IP girilmemis olabilir. Ikisinde de
            // CIKMAYIZ - cikarsak bir daha kimse baslatmaz ve veri hic akmaz.
            // Liste ListeyiEsitle ile (hazir olana kadar sik, sonra dakikada bir)
            // yeniden denenir ve tezgahlar o zaman baslar.
            List<string[]> liste = ListeyiCek();
            ListeSonBasarili = liste != null;
            if (liste == null)
            {
                Console.WriteLine("[ajan] backend henuz hazir degil, bekleniyor. Hazir olunca");
                Console.WriteLine("       tezgahlar kendiliginden baslayacak.");
            }
            else if (liste.Count == 0)
            {
                Console.WriteLine("[ajan] backend'de IP'si tanimli tezgah yok. Dashboard > Ayarlar");
                Console.WriteLine("       ekranindan IP girince ajan kendiliginden alir.");
            }
            else
            {
                foreach (string[] p in liste) Ekle(p[0], p[1]);
            }
        }

        // Backend modunda bos liste hata degil (beklenir). Digerlerinde, hic
        // tezgah yoksa yapilacak bir sey yok.
        if (Tezgahlar.Count == 0 && ListeUrl == null)
        {
            Console.WriteLine("[ajan] gecerli tezgah bulunamadi.");
            return false;
        }

        if (Tezgahlar.Count > 0)
        {
            Console.WriteLine("[ajan] " + Tezgahlar.Count + " tezgah:");
            foreach (Tezgah t in Tezgahlar) Console.WriteLine("        " + t.Id.PadRight(10) + t.Host);
        }
        Console.WriteLine();
        return true;
    }

    /// http://pc:3000/api/ingest  ->  http://pc:3000/api/agent/machines?driver=...
    static string ListeAdresi(string ingest)
    {
        int i = ingest.IndexOf("/api/", StringComparison.OrdinalIgnoreCase);
        string kok = i > 0 ? ingest.Substring(0, i) : ingest.TrimEnd('/');
        return kok + "/api/agent/machines?driver=syntec-remoteapi";
    }

    /// @returns id/ip ciftleri; backend'e ulasilamazsa null (bos liste DEGIL -
    /// ikisi ayirt edilmezse gecici bir kesintide tum tezgahlar kapatilirdi).
    static List<string[]> ListeyiCek()
    {
        string govde;
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(ListeUrl);
            req.Timeout = 10000;
            using (var yanit = (HttpWebResponse)req.GetResponse())
            using (var okuyucu = new StreamReader(yanit.GetResponseStream(), Encoding.UTF8))
                govde = okuyucu.ReadToEnd();
        }
        catch { return null; }

        var liste = new List<string[]>();
        foreach (Match blok in Regex.Matches(govde, @"\{[^{}]*\}"))
        {
            string id = Alan(blok.Value, "id");
            string ip = Alan(blok.Value, "ip");
            if (id != null && ip != null) liste.Add(new[] { id, ip });
        }
        return liste;
    }

    static string Alan(string json, string ad)
    {
        Match m = Regex.Match(json, "\"" + ad + "\"\\s*:\\s*\"([^\"]*)\"");
        return m.Success && m.Groups[1].Value.Length > 0 ? m.Groups[1].Value : null;
    }

    static Tezgah Ekle(string id, string host)
    {
        var t = new Tezgah();
        t.Id = id;
        t.Host = host;
        t.Okuyucu = new SyntecReader(host, id);
        lock (TezgahKilit) Tezgahlar.Add(t);
        return t;
    }

    /// Yapilandirma degistiginde ajani yeniden baslatmaya gerek kalmasin diye
    /// listeyi periyodik karsilastirir: yeni tezgaha is parcacigi acar,
    /// cikarilani durdurur.
    static void ListeyiEsitle()
    {
        if (ListeUrl == null) return;
        List<string[]> liste = ListeyiCek();
        if (liste == null)
        {
            // Backend gecici olarak yok - mevcut tezgahlara dokunma. Ayni uyariyi
            // her denemede basma, yalnizca durum degisince.
            if (ListeSonBasarili) Console.WriteLine("[ajan] backend'e ulasilamiyor, bekleniyor");
            ListeSonBasarili = false;
            return;
        }
        if (!ListeSonBasarili) Console.WriteLine("[ajan] backend'e ulasildi");
        ListeSonBasarili = true;

        var gelen = new Dictionary<string, string>();
        foreach (string[] p in liste) gelen[p[0]] = p[1];

        lock (TezgahKilit)
        {
            foreach (Tezgah t in Tezgahlar)
            {
                if (t.Dur) continue; // zaten kapaniyor, karsilastirmaya girmesin
                string ip;
                if (!gelen.TryGetValue(t.Id, out ip))
                {
                    t.Dur = true;
                    Console.WriteLine("[ajan] " + t.Id + " yapilandirmadan cikarildi, okuma durduruluyor");
                }
                else if (ip != t.Host)
                {
                    // IP degisti: eskiyi durdur, `gelen`de kaldigi icin yenisi acilacak.
                    t.Dur = true;
                    Console.WriteLine("[ajan] " + t.Id + " IP degisti: " + t.Host + " -> " + ip);
                }
                else gelen.Remove(t.Id); // degismemis
            }
        }

        foreach (var kv in gelen)
        {
            Console.WriteLine("[ajan] yeni tezgah: " + kv.Key + " (" + kv.Value + ")");
            IsParcacigiBaslat(Ekle(kv.Key, kv.Value));
        }
    }

    static void IsParcacigiBaslat(Tezgah t)
    {
        Tezgah yerel = t;
        var th = new Thread(delegate() { TezgahDongusu(yerel); });
        th.IsBackground = true;
        th.Name = "oku-" + t.Id;
        th.Start();
    }

    /// Tek tezgahin okuma dongusu - kendi is parcaciginda.
    static void TezgahDongusu(Tezgah t)
    {
        // Syntec'in native DLL'i yuklenebiliyor mu? Yuklenemiyorsa (eksik Visual C++
        // calisma zamani gibi) Syntec kutuphanesi sessizce "baglanti yok" der ve
        // ajan nedensiz KOPUK gorunur. Burada nedeni acikca yaziyoruz ve DLL
        // yuklenebilene kadar bekliyoruz; Syntec tiplerine bu sirada DOKUNMUYORUZ
        // (statik baslaticilari bir kez cokerse surec yeniden baslayana kadar duzelmez).
        string onHata;
        while (Calisiyor && !t.Dur && (onHata = SyntecReader.NativeKontrol(DllYolu)) != null)
        {
            if (onHata != t.SonHata)
            {
                t.SonHata = onHata;
                Console.WriteLine("[" + t.Id + "] " + onHata);
            }
            Bekle(15000);
        }
        if (!Calisiyor || t.Dur) return;
        t.SonHata = null;

        string hata = t.Okuyucu.Baglan(DllYolu);
        if (hata != null)
        {
            // DLL hatasi kalicidir, yeniden denemenin anlami yok.
            Console.WriteLine("[" + t.Id + "] " + hata);
            return;
        }

        bool kimlikYazildi = false;

        while (Calisiyor && !t.Dur)
        {
            if (!t.Bagli)
            {
                if (t.Okuyucu.BaglantiVar())
                {
                    t.Bagli = true;
                    t.YenidenSayisi = 0;
                    t.SonHata = null;
                    Console.WriteLine("[" + t.Id + "] baglandi (" + t.Host + ")");
                    if (!kimlikYazildi)
                    {
                        kimlikYazildi = true;
                        foreach (var kv in t.Okuyucu.Kimlik())
                            Console.WriteLine("[" + t.Id + "]   " + kv.Key + ": " + kv.Value);
                    }
                }
                else
                {
                    // Once ESKI oturumu duzgun kapat (yoksa tornada acik kalir), sonra yenisini
                    // ac. Bekleme her basarisizlikta uzar: surekli ve sik denemek tornaya yuk
                    // bindirir ve oturum sizdirir.
                    KapatArkaPlanda(t.Okuyucu, 3000);
                    t.Okuyucu = new SyntecReader(t.Host, t.Id);
                    string h = t.Okuyucu.Baglan(DllYolu);
                    if (h != null && h != t.SonHata)
                    {
                        t.SonHata = h;
                        Console.WriteLine("[" + t.Id + "] baglanamadi: " + h);
                    }
                    t.YenidenSayisi++;
                    Bekle(GeriCekilmeMs(t.YenidenSayisi));
                    continue;
                }
            }

            // Okuma ayri bir is parcaciginda, zaman asimiyla: takilirsa biz de takilmayiz.
            Dictionary<string, object> d = null;
            Exception okumaHatasi = null;
            SyntecReader okuyucu = t.Okuyucu;
            Thread isci = new Thread(delegate()
            {
                try { d = okuyucu.Oku(); }
                catch (Exception ex) { okumaHatasi = ex; }
            });
            isci.IsBackground = true;
            isci.Name = "cagri-" + t.Id;
            isci.Start();

            if (!isci.Join(OkumaZamanAsimiMs))
            {
                // Takildi. Is parcacigi (native cagri icinde) oldurulemez; terk edip yeni bir
                // okuyucu nesnesiyle yeniden deneriz. Eski nesneye DOKUNMUYORUZ (Disconnect de
                // takilabilir).
                t.Bagli = false;
                t.TakiliSayisi++;
                t.SonTakilma = DateTime.Now;
                string takildi = "okuma " + (OkumaZamanAsimiMs / 1000) + " sn'dir yanit vermiyor (Syntec cagrisi takildi)";
                t.SonHata = takildi;
                Console.WriteLine("[" + t.Id + "] " + takildi + " [" + t.TakiliSayisi + "/" + MaksTakili + "]");

                if (t.TakiliSayisi >= MaksTakili)
                {
                    // PARK: bu tezgah icin artik cagri acmiyoruz. Her denemede terk edilen bir
                    // is parcacigi kaliyor; surekli denersek gunler icinde binlercesi birikir.
                    // Ozet satiri KOPUK + bu mesaji gostermeye devam eder.
                    t.SonHata = takildi + "; PARK EDILDI, duzelince ajan gorevini yeniden baslatin";
                    Console.WriteLine("[" + t.Id + "] " + MaksTakili + " kez ust uste takildi: yeni okuma acilmiyor. " +
                                      "Torna PC'ye geri baglanamiyor olabilir (birden fazla ag karti / guvenlik duvari " +
                                      "5568-5570). Duzelince ajan gorevini yeniden baslatin.");
                    while (Calisiyor && !t.Dur) Bekle(1000);
                    return;
                }

                // Takilan oturumu kapatmayi DENE (zaman asimli): terk etmek tornada acik birakir.
                KapatArkaPlanda(okuyucu, 3000);
                t.Okuyucu = new SyntecReader(t.Host, t.Id);
                string yh = t.Okuyucu.Baglan(DllYolu);
                if (yh != null) { Console.WriteLine("[" + t.Id + "] " + yh); return; }
                Bekle(GeriCekilmeMs(t.TakiliSayisi));
                continue;
            }

            if (okumaHatasi != null)
            {
                t.Bagli = false;
                Console.WriteLine("[" + t.Id + "] okuma hatasi: " + SyntecReader.Kok(okumaHatasi).Message);
            }
            else if (d == null || d.Count == 0)
            {
                // Hicbir fonksiyon donmedi - baglanti kopmus say.
                t.Bagli = false;
                Console.WriteLine("[" + t.Id + "] yanit yok, yeniden baglanilacak");
                continue;
            }
            else if (string.IsNullOrEmpty(Convert.ToString(SyntecReader.Al(d, "Status"))))
            {
                // Fonksiyonlar "basarili" dondu ama Status bos: gercek veri gelmiyor (yarim
                // kurulmus baglanti). Bunu IDLE diye YAYMAYIZ - sahte "Bosta" yanlis rapor demek.
                const string sorun = "tezgah bos yanit veriyor (Status bos): baglanti yarim kurulmus olabilir " +
                                     "(torna PC'ye geri baglanamiyor mu? ag karti / guvenlik duvari 5568-5570)";
                if (t.YanitSorunu != sorun)
                {
                    t.YanitSorunu = sorun;
                    Console.WriteLine("[" + t.Id + "] " + sorun);
                }
            }
            else
            {
                if (t.YanitSorunu != null)
                {
                    t.YanitSorunu = null;
                    Console.WriteLine("[" + t.Id + "] gecerli yanit geliyor");
                }
                if (t.TakiliSayisi > 0 && (DateTime.Now - t.SonTakilma).TotalMinutes >= 5)
                    t.TakiliSayisi = 0;
                t.SonHata = null;
                Kuyrukla(t.Okuyucu.TelemetriJson(d));
                t.Okunan++;
                t.SonBasari = DateTime.Now;
                Interlocked.Increment(ref ToplamOkunan);
            }

            Bekle(AralikMs);
        }

        if (t.Dur)
        {
            // Tezgah yapilandirmadan cikarildi: oturumunu duzgun kapat.
            KapatArkaPlanda(t.Okuyucu, 3000);
            Console.WriteLine("[" + t.Id + "] okuma durduruldu");
        }
    }

    static void Kuyrukla(string json)
    {
        lock (TamponKilit)
        {
            Tampon.Add(json);
            // Backend uzun sure kapali kalirsa en ESKI kayitlar dusurulur:
            // canli durum, eski gecmisten daha degerli.
            if (Tampon.Count > TamponSiniri)
            {
                int fazla = Tampon.Count - TamponSiniri;
                Tampon.RemoveRange(0, fazla);
                Interlocked.Add(ref ToplamDusen, fazla);
            }
        }
    }

    static void GondericiDongusu()
    {
        bool online = true;
        while (Calisiyor)
        {
            bool ok = Gonder();
            if (ok != online)
            {
                online = ok;
                Console.WriteLine(ok ? "[ajan] backend'e baglandi" : "[ajan] backend yanit vermiyor, tamponlaniyor");
            }
            Bekle(1000);
        }
    }

    /// Tamponu tek istekte gonderir. Basarisizsa mesajlar tamponda kalir.
    static bool Gonder()
    {
        string[] batch;
        lock (TamponKilit)
        {
            if (Tampon.Count == 0) return true;
            batch = Tampon.ToArray();
            Tampon.Clear();
        }

        var sb = new StringBuilder("[");
        for (int i = 0; i < batch.Length; i++)
        {
            if (i > 0) sb.Append(",");
            sb.Append(batch[i]);
        }
        sb.Append("]");

        try
        {
            var req = (HttpWebRequest)WebRequest.Create(IngestUrl);
            req.Method = "POST";
            req.ContentType = "application/json";
            req.Timeout = 15000;
            byte[] govde = Encoding.UTF8.GetBytes(sb.ToString());
            req.ContentLength = govde.Length;
            using (Stream s = req.GetRequestStream()) s.Write(govde, 0, govde.Length);
            using (var yanit = (HttpWebResponse)req.GetResponse())
            {
                if ((int)yanit.StatusCode >= 300)
                    throw new Exception("HTTP " + (int)yanit.StatusCode);
            }
            Interlocked.Add(ref ToplamGonderilen, batch.Length);
            return true;
        }
        catch
        {
            // Gonderilemedi - mesajlari tamponun BASINA geri koy, sira korunsun.
            lock (TamponKilit)
            {
                Tampon.InsertRange(0, batch);
                if (Tampon.Count > TamponSiniri)
                {
                    int fazla = Tampon.Count - TamponSiniri;
                    Tampon.RemoveRange(0, fazla);
                    Interlocked.Add(ref ToplamDusen, fazla);
                }
            }
            return false;
        }
    }

    /// Tezgah listesini ne siklikla tazeleyecegiz: liste hazir ve en az bir tezgah
    /// varken dakikada bir; backend yokken ya da liste BOSKEN sik (5 sn). Boylece
    /// acilista backend gec kalsa da ilk veri bir dakika gecikmez.
    static int EsitlemeAraligiSn()
    {
        int sayi;
        lock (TezgahKilit) sayi = Tezgahlar.Count;
        return (ListeUrl != null && (!ListeSonBasarili || sayi == 0)) ? 5 : 60;
    }

    /// Dakikada bir ozet satiri - servis olarak calisirken log dosyasina duser.
    static void DurumDongusu()
    {
        DateTime sonrakiOzet = DateTime.Now.AddMinutes(1);
        DateTime sonrakiEsitleme = DateTime.Now.AddSeconds(EsitlemeAraligiSn());
        while (Calisiyor)
        {
            Bekle(500);

            // Ayarlar ekranindan tezgah eklenir/cikarilirsa ajan yeniden
            // baslatilmadan yakalasin.
            if (DateTime.Now >= sonrakiEsitleme)
            {
                sonrakiEsitleme = DateTime.Now.AddSeconds(EsitlemeAraligiSn());
                try { ListeyiEsitle(); }
                catch (Exception ex) { Console.WriteLine("[ajan] liste esitlenemedi: " + ex.Message); }
            }

            if (DateTime.Now < sonrakiOzet) continue;
            sonrakiOzet = DateTime.Now.AddMinutes(1);

            int bekleyen;
            lock (TamponKilit) bekleyen = Tampon.Count;

            var sb = new StringBuilder();
            sb.Append("[ajan] ").Append(DateTime.Now.ToString("HH:mm:ss"));
            sb.Append("  okunan=").Append(ToplamOkunan);
            sb.Append(" gonderilen=").Append(ToplamGonderilen);
            sb.Append(" bekleyen=").Append(bekleyen);
            if (ToplamDusen > 0) sb.Append(" DUSEN=").Append(ToplamDusen);
            Console.WriteLine(sb.ToString());

            Tezgah[] anlik;
            lock (TezgahKilit) anlik = Tezgahlar.ToArray();
            foreach (Tezgah t in anlik)
            {
                if (t.Dur) continue;
                if (!t.Bagli)
                    Console.WriteLine("        " + t.Id + " KOPUK" +
                                      (t.SonHata == null ? "" : " (" + t.SonHata + ")"));
                // Bagli gorunuyor ama gelen yanit gecersiz: ozet bunu da gostersin.
                else if (t.YanitSorunu != null)
                    Console.WriteLine("        " + t.Id + " VERI YOK: " + t.YanitSorunu);
                // Durum eslemesinde taninmayan deger ciktiysa duyur: RUNNING
                // karsiligini sahadan ogrenmek icin bu uyari onemli.
                if (t.Okuyucu.BilinmeyenDurum.Count > 0)
                {
                    Console.WriteLine("        " + t.Id + " TANINMAYAN DURUM: " +
                                      string.Join(", ", new List<string>(t.Okuyucu.BilinmeyenDurum).ToArray()));
                    t.Okuyucu.BilinmeyenDurum.Clear();
                }
            }
        }
    }

    /// Kapanma istegine duyarli bekleme - Ctrl+C sonrasi 10 sn beklemesin.
    static void Bekle(int ms)
    {
        int adim = 200;
        while (ms > 0 && Calisiyor)
        {
            int bu = ms < adim ? ms : adim;
            Thread.Sleep(bu);
            ms -= bu;
        }
    }

    static void Yardim()
    {
        Console.WriteLine("Syntec Edge Agent - tezgahlari surekli okur, backend'e JSON gonderir.");
        Console.WriteLine();
        Console.WriteLine("  (varsayilan)         tezgah listesini BACKEND'den alir - ayarlar");
        Console.WriteLine("                       ekraninda IP'si tanimli tezgahlar. Liste dakikada");
        Console.WriteLine("                       bir tazelenir; ekleme/cikarma icin yeniden baslatma");
        Console.WriteLine("                       gerekmez. Backend henuz hazir degilse CIKMAZ,");
        Console.WriteLine("                       hazir olana kadar bekler (acilista servis olarak).");
        Console.WriteLine("  --machines <dosya>   backend yerine yerel dosya (varsayilan machines.txt");
        Console.WriteLine("                       varsa kullanilir); her satir:  CNC-01=192.168.1.101");
        Console.WriteLine("  --host <ip>          tek tezgah icin (listeyi gecersiz kilar)");
        Console.WriteLine("  --machine-id <id>    --host ile birlikte (varsayilan CNC-01)");
        Console.WriteLine("  --ingest <url>       backend adresi (varsayilan http://127.0.0.1:3000/api/ingest)");
        Console.WriteLine("  --log <dosya>        ciktiyi dosyaya da yazar (5 MB'ta doner)");
        Console.WriteLine("  --interval <ms>      okuma araligi (varsayilan 1000)");
        Console.WriteLine("  --retry <ms>         yeniden baglanma araligi (varsayilan 10000)");
        Console.WriteLine("  --read-timeout <ms>  bir okuma bu sureden uzun surerse takildi sayilir (varsayilan 15000)");
        Console.WriteLine("  --duration <sn>      test icin: N saniye sonra duzgun kapanir");
        Console.WriteLine("  --dll <dosya>        Syntec.RemoteCNC.Win32.dll");
        Console.WriteLine();
        Console.WriteLine("Bu program Syntec dll'lerinin bulundugu klasorden calistirilmali.");
    }

    static Dictionary<string, string> Args(string[] argv)
    {
        var d = new Dictionary<string, string>();
        for (int i = 0; i < argv.Length; i++)
        {
            if (!argv[i].StartsWith("--")) continue;
            string k = argv[i].Substring(2);
            string v = (i + 1 < argv.Length && !argv[i + 1].StartsWith("--")) ? argv[++i] : "1";
            d[k] = v;
        }
        return d;
    }

    static string Get(Dictionary<string, string> d, string k, string varsayilan)
    {
        string v;
        return d.TryGetValue(k, out v) ? v : varsayilan;
    }
}
