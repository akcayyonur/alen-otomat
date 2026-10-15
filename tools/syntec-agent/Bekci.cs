// Ajan bekcisi (--supervise).
//
// NEDEN VAR: 2026-10-14 04:21'de fabrika PC'sinde 11TB ajani (yedi torna) sessizce
// durdu: gunluge tek satir yazilmadi, ne cokus iz biraktigi ne de Gorev Zamanlayici onu
// yeniden baslatti; veri sabaha kadar gelmedi, kullanici gelip elle yeniden baslatti.
// Surecin olmus mu donmus mu oldugu gunlukten ayirt edilemedi. Gorev Zamanlayici'nin
// "hata olursa yeniden baslat" ayari yalnizca surec HATA KODUYLA cikarsa isler; donmus
// (calisiyor gorunen) surec icin hicbir sey yapmaz.
//
// NE YAPAR: asil ajani ALT SUREC olarak (ayni exe, --supervise OLMADAN) calistirir ve izler:
//   - alt surec cikarsa (cokus, SertCikis, disaridan oldurulme: cikis kodu fark etmez)
//     birkac saniye sonra yeniden baslatir;
//   - alt surec DONARSA yeniden baslatir. Donma olcusu: ajanin gunluk dosyasi. Ajan her
//     dakika bir ozet satiri yazar (ana is parcaciginin kalp atisi); --stale-sec saniyedir
//     (varsayilan 240) gunluk degismediyse surec donmus sayilir, oldurulur, yeniden baslar.
//     Oldurmeden once surecin is parcacigi dokumu bekci gunluguna yazilir (neden donduguna
//     dair tek ipucu: hangi is parcaciklari bekliyor, hangisi CPU yiyor).
//
// TORNA BASINA SUREC (0.5.0, 2026-10-15, VARSAYILAN KIP): ayni gun 16:50'de 11TB ajaninin dort tornasi AYNI SANIYEDE takildi ve 17,5 saat tek okuma
// yapilmadi; ajanin ana dongusu ozet satiri yazmaya devam ettigi icin bekci "donmadi" saydi (gunluk dosyasi guncel kalir). Syntec istemcisi
// tek surecte tum tornalari birbirine baglayabiliyor (takilan bir native cagri surecte baska cagrilarin ilerlemesini de engelleyebilir), takilan
// cagri oldurulemez ve surec icinden toparlanma guvenilir degil: TEK GUVENILIR TOPARLANMA SURECI OLDURMEKTIR (sureci oldurmek tornadaki
// oturumlari da TCP kapanarak serbest birakir). Bu yuzden bekci ARTIK HER TORNA ICIN AYRI ajan sureci acar (ajan --host <ip> --machine-id <id>):
//   - tezgah listesini backend'den alir (varsayilan 60 sn'de bir esitler): yeni tornaya surec acar, cikarilanin surecini kapatir, IP degisirse yeniden baslatir;
//   - bir surecin ciktisini (stdout) okuyup ortak ajan gunlugune (--log) yazar: tek dosyada tum tornalar, her satir tarih-saatli ve [CNC-xx] etiketli;
//   - bir surec cikarsa yeniden baslatir; --stale-sec (240) sn hic cikti vermezse DONMUS sayar; --idle-sec (300) sn tek okuma yapamazsa
//     (ozet satirindaki okunan= sayaci artmazsa) "ILERLEME YOK" sayar: oldurmeden once is parcacigi dokumunu yazar ve YALNIZ O sureci yeniden baslatir.
//     Ilerlemesiz yeniden baslatmalar ust uste olursa bekleme uzar (300 -> 600 -> 1200 -> 1800 sn tavan): kapali bir tornayi bosuna zorlamayiz;
//   - 5 dakikada bir tek satir "isciler: CNC-01 okuyor | CNC-02 OKUMA YOK ..." yazar (uzaktan teshis icin).
// Eski kip (tum tornalar tek ajan surecinde) --tek-surec ile ya da --host/--machines/machines.txt varken kullanilir.
//
// Bekci Syntec DLL'lerine HIC dokunmaz: kendisi donabilecek hicbir seyi yuklemez. Alt surec
// bir "job" nesnesine baglanir (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE): bekci oldurulurse
// (Gorev Zamanlayici gorevi durdurunca) alt surec de sonlanir, torna oturumlari TCP kapaninca
// sunucu tarafinda serbest kalir (CLAUDE.md: "surec ani oldurulunce sunucu oturumu birakir").
//
// Bekcinin kendi kaydi: <log>.bekci.log (ornegin ajan.bekci.log), ajanin gunlugundan AYRI -
// iki surec ayni dosyaya yazmasin.
//
// Hedef: .NET Framework 4.0 / C# 4.0.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Syntec.Telemetri;

static class Bekci
{
    const int VarsayilanDonmaSn = 240;
    const uint KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;

    static volatile bool Durdur;

    [StructLayout(LayoutKind.Sequential)]
    struct IoSayaclari
    {
        public ulong Okuma, Yazma, Diger, OkumaBayt, YazmaBayt, DigerBayt;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JobTemel
    {
        public long ProcessUserTimeLimit;
        public long JobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JobGenis
    {
        public JobTemel Temel;
        public IoSayaclari Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr nitelik, string ad);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int sinif, IntPtr bilgi, uint uzunluk);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr surec);

    // Job tutamagi bekci olunceye kadar ACIK kalir (kapanmasi alt sureci oldurur).
    static IntPtr Job = IntPtr.Zero;

    [StructLayout(LayoutKind.Sequential)]
    struct BellekDurumu
    {
        public uint Uzunluk, Yuk;
        public ulong ToplamFiziksel, BosFiziksel, ToplamSayfa, BosSayfa, ToplamSanal, BosSanal, BosGenisletilmis;
    }

    [DllImport("kernel32.dll")]
    static extern bool GetSystemTimes(out long bosta, out long cekirdek, out long kullanici);
    [DllImport("kernel32.dll")]
    static extern bool GlobalMemoryStatusEx(ref BellekDurumu durum);

    /// Duraklama izleyicisi: her saniye uyanir; iki uyanis arasi 8 sn'yi asarsa bu surec (yani
    /// buyuk olasilikla BUTUN PC) o sure boyunca calisamamistir. Fabrikada "neredeyse her gun
    /// ~2 dk veri yok": ayni dakikada iki ajan + backend + 8 tornanin hepsi yanit vermedi
    /// (2026-10-09 23:54, 2026-10-14 04:21), yani tornalar ya da ajan degil PC/ag duraklamasi
    /// supheli. Bu satir, duraklamanin sistem capinda olup olmadigini ve o sirada islemcinin
    /// mesgul (islemci yetmiyor) mu bos (disk/ag bekleniyor, ya da PC uyudu) mu oldugunu soyler.
    /// Hicbir ajan/Syntec koduna dokunmaz; bekci surecinin kendi is parcacigidir.
    static void DuraklamaIzle()
    {
        Stopwatch sw = Stopwatch.StartNew();
        long onceki = sw.ElapsedMilliseconds;
        DateTime oncekiSaat = DateTime.UtcNow;
        long b0, k0, u0;
        GetSystemTimes(out b0, out k0, out u0);
        while (!Durdur)
        {
            Thread.Sleep(1000);
            long simdi = sw.ElapsedMilliseconds;
            DateTime saat = DateTime.UtcNow;
            long b1, k1, u1;
            GetSystemTimes(out b1, out k1, out u1);

            double olcuSn = (simdi - onceki) / 1000.0;
            double saatSn = (saat - oncekiSaat).TotalSeconds;
            if (olcuSn > 8 || saatSn > 8)
            {
                // GetSystemTimes: cekirdek suresi BOSTA suresini de icerir.
                long toplam = (k1 - k0) + (u1 - u0);
                long bos = b1 - b0;
                string mesgul = toplam > 0 ? (100.0 * (toplam - bos) / toplam).ToString("0") + "%" : "?";
                string bellek = "?";
                try
                {
                    BellekDurumu m = new BellekDurumu();
                    m.Uzunluk = (uint)Marshal.SizeOf(typeof(BellekDurumu));
                    if (GlobalMemoryStatusEx(ref m))
                        bellek = (m.BosFiziksel / 1048576) + " MB bos, bellek yuku %" + m.Yuk;
                }
                catch { }
                Yaz("SISTEM DURAKLAMASI: bekci " + ((int)Math.Max(olcuSn, saatSn)) + " sn calisamadi (beklenen 1 sn; olcum " +
                    ((int)olcuSn) + " sn, saat farki " + ((int)saatSn) + " sn). O aralikta islemci " + mesgul +
                    " mesguldu; " + bellek +
                    ". Islemci ~%100 ise PC islemci/disk yuzunden donmus; ~%0 ise disk/ag bekliyor ya da PC uyumus olabilir");
            }
            onceki = simdi;
            oncekiSaat = saat;
            b0 = b1; k0 = k1; u0 = u1;
        }
    }

    public static int Calistir(string[] argv, Dictionary<string, string> arg)
    {
        string logYolu;
        if (!arg.TryGetValue("log", out logYolu))
        {
            Console.WriteLine("[bekci] --supervise icin --log <dosya> gerekli (ajan ciktisi bu dosyaya yazilir)");
            return 1;
        }
        logYolu = Path.GetFullPath(logYolu);

        int donmaSn = VarsayilanDonmaSn;
        string deger;
        if (arg.TryGetValue("stale-sec", out deger)) int.TryParse(deger, out donmaSn);
        if (donmaSn < 15) donmaSn = 15;
        int bostaSn = 300;
        if (arg.TryGetValue("idle-sec", out deger)) int.TryParse(deger, out bostaSn);
        if (bostaSn < 30) bostaSn = 30;
        int listeSn = 60;
        if (arg.TryGetValue("list-sec", out deger)) int.TryParse(deger, out listeSn);
        if (listeSn < 2) listeSn = 2;

        string bekciLog = Path.Combine(Path.GetDirectoryName(logYolu),
                                       Path.GetFileNameWithoutExtension(logYolu) + ".bekci.log");
        Console.SetOut(new DosyaYazici(Console.Out, bekciLog));

        Console.CancelKeyPress += delegate(object s, ConsoleCancelEventArgs e)
        {
            e.Cancel = true;
            Durdur = true;
        };

        string exe = Assembly.GetEntryAssembly().Location;
        string calismaDizini = Directory.GetCurrentDirectory();
        string surum = Assembly.GetEntryAssembly().GetName().Version.ToString();

        Job = IsKur();

        // Torna basina surec: tezgah listesi backend'den gelir. --host / --machines / machines.txt ya da --tek-surec varsa eski kip.
        bool tekSurec = arg.ContainsKey("tek-surec") || arg.ContainsKey("host") || arg.ContainsKey("machines") ||
                        File.Exists(Path.Combine(calismaDizini, "machines.txt"));

        Thread izleyici = new Thread(DuraklamaIzle);
        izleyici.IsBackground = true;
        izleyici.Name = "duraklama-izle";

        if (!tekSurec)
        {
            Yaz("bekci basladi (pid " + Process.GetCurrentProcess().Id + ", surum " + surum + "); kip: TORNA BASINA SUREC; surec: " + exe + " " + AltArgumanlar(argv, false) + " --host <ip> --machine-id <id>");
            izleyici.Start();
            return IsciKipi(exe, calismaDizini, argv, arg, logYolu, donmaSn, bostaSn, listeSn);
        }

        string altArgs = AltArgumanlar(argv, true);
        Yaz("bekci basladi (pid " + Process.GetCurrentProcess().Id + ", surum " + surum + "); kip: TEK SUREC; alt surec: " + exe + " " + altArgs);
        Yaz("donma siniri: ajan gunlugu " + donmaSn + " sn degismezse yeniden baslatilir (" + logYolu + ")");
        izleyici.Start();

        int hizliCikis = 0;
        while (!Durdur)
        {
            DateTime basladi = DateTime.UtcNow;
            Process alt = null;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(exe, altArgs);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WorkingDirectory = calismaDizini;
                alt = Process.Start(psi);
                JoblaBagla(alt);
                Yaz("ajan baslatildi (pid " + alt.Id + ")");
            }
            catch (Exception ex)
            {
                Yaz("ajan baslatilamadi: " + ex.Message);
                Bekle(15000);
                continue;
            }

            string sonuc = Izle(alt, basladi, logYolu, donmaSn);
            double omurSn = (DateTime.UtcNow - basladi).TotalSeconds;

            if (Durdur)
            {
                Yaz("durduruluyor: ajanin duzgun kapanmasi bekleniyor (en cok 15 sn)");
                SureciKapat(alt, 15000);
                break;
            }

            if (sonuc == "donmus")
            {
                Yaz("AJAN DONMUS: gunluk " + donmaSn + " sn'dir degismedi. Is parcacigi dokumu:");
                IsParcaciklariniYaz(alt);
                SureciKapat(alt, 30000);
                Yaz("donmus ajan sonlandirildi, yeniden baslatilacak");
            }

            // Hizli tekrarlayan cikislarda bekleme uzar (5 -> 10 -> 20 -> 40 -> 60 sn; ajan en az
            // 60 sn calistiysa sayac sifirlanir ve yine 5 sn): bozuk bir
            // kurulumda saniyede bir surec acip kapatarak sistemi bogmayalim.
            hizliCikis = omurSn < 60 ? hizliCikis + 1 : 0;
            int bekle = Math.Min(60, 5 << Math.Min(hizliCikis > 0 ? hizliCikis - 1 : 0, 4));
            Yaz("ajan " + Sure(omurSn) + " calisti; " + bekle + " sn sonra yeniden baslatilacak");
            Bekle(bekle * 1000);
        }
        Yaz("bekci kapandi");
        return 0;
    }

    // ====================================================================== TORNA BASINA SUREC KIPI

    class Isci
    {
        public string Id, Host;
        public Process Surec;
        /// Hepsi UTC. SonSatir: surecten gelen son cikti satiri; SonIlerleme: okunan= sayacinin en son ARTTIGI an (ya da baslama).
        public DateTime Basladi, SonSatir, SonIlerleme, Sonraki;
        public long Okunan;
        /// Ajanin ozet satirindaki son "CNC-xx KOPUK (neden)" metni; ilerleme olunca silinir. Yeniden baslatma satirina eklenir.
        public string SonKopuk;
        public int HizliCikis, IlerlemesizSayisi, Yeniden;
        public readonly object Kilit = new object();
    }

    static readonly Regex OkunanRe = new Regex(@"okunan=(\d+)", RegexOptions.Compiled);
    /// Torna surecleri cikti dosyasi (--log): tum tornalar tek dosyada, satirlar tarih-saatli ve [CNC-xx] etiketli.
    static DosyaYazici AjanLog;
    static bool ListeUyarildi;

    static string ListeAdresi(string ingest, string model)
    {
        int i = ingest.IndexOf("/api/", StringComparison.OrdinalIgnoreCase);
        string kok = i > 0 ? ingest.Substring(0, i) : ingest.TrimEnd('/');
        return kok + "/api/agent/machines?driver=syntec-remoteapi&model=" + Uri.EscapeDataString(model ?? "");
    }

    /// id/ip ciftleri; backend'e ulasilamazsa null (bos liste DEGIL: gecici kesintide tum surecler kapatilmasin).
    static List<string[]> ListeCek(string url)
    {
        string govde;
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 10000;
            req.Proxy = null;
            using (HttpWebResponse yanit = (HttpWebResponse)req.GetResponse())
            using (StreamReader okuyucu = new StreamReader(yanit.GetResponseStream(), Encoding.UTF8))
                govde = okuyucu.ReadToEnd();
        }
        catch { return null; }

        List<string[]> liste = new List<string[]>();
        foreach (Match blok in Regex.Matches(govde, @"\{[^{}]*\}"))
        {
            string id = Alan(blok.Value, "id");
            string ip = Alan(blok.Value, "ip");
            if (id != null && ip != null) liste.Add(new string[] { id, ip });
        }
        return liste;
    }

    static string Alan(string json, string ad)
    {
        Match m = Regex.Match(json, "\"" + ad + "\"\\s*:\\s*\"([^\"]*)\"");
        return m.Success && m.Groups[1].Value.Length > 0 ? m.Groups[1].Value : null;
    }

    static int IsciKipi(string exe, string calismaDizini, string[] argv, Dictionary<string, string> arg,
                        string logYolu, int donmaSn, int bostaSn, int listeSn)
    {
        string ingest = arg.ContainsKey("ingest") ? arg["ingest"] : "http://127.0.0.1:3000/api/ingest";
        // Model: ajanla AYNI kural (Agent.Main). --model yoksa bulunulan klasordeki Syntec paketinden anlasilir; bos birakilirsa backend
        // TUM modellerin tornalarini verirdi ve 11TB paketiyle 22TB tornasina da surec acilirdi. (Yalnizca dosya adi/varligi bakilir:
        // bekci Syntec DLL'ini yuklemez.)
        string dll = arg.ContainsKey("dll") ? arg["dll"] : SyntecReader.VarsayilanDll(calismaDizini);
        string model = arg.ContainsKey("model") ? arg["model"].Trim().ToUpperInvariant() : SyntecReader.DllModeli(dll);
        string url = ListeAdresi(ingest, model);
        string temelArgs = AltArgumanlar(argv, false);
        AjanLog = new DosyaYazici(TextWriter.Null, logYolu);

        Yaz("model: " + model + "; tezgah listesi: " + url);
        Yaz("her torna AYRI surec; " + donmaSn + " sn hic cikti yoksa DONMUS, " + bostaSn +
            " sn tek okuma yoksa ILERLEME YOK sayilir ve YALNIZ o surec yeniden baslatilir; ajan ciktisi: " + logYolu);

        List<Isci> isciler = new List<Isci>();
        bool listeTamam = false;
        DateTime sonListe = DateTime.MinValue;
        DateTime sonOzet = DateTime.UtcNow.AddMinutes(5);
        int sira = 0;
        while (!Durdur)
        {
            if (DateTime.UtcNow >= sonListe)
            {
                listeTamam = ListeyiEsitle(url, isciler, listeTamam, ref sira);
                // Liste hazir ve en az bir torna varken listeSn'de bir; backend yokken / liste bosken sik (en cok 5 sn).
                sonListe = DateTime.UtcNow.AddSeconds((listeTamam && isciler.Count > 0) ? listeSn : Math.Min(listeSn, 5));
            }
            foreach (Isci i in isciler.ToArray()) Denetle(i, exe, calismaDizini, temelArgs, donmaSn, bostaSn);
            if (DateTime.UtcNow >= sonOzet)
            {
                sonOzet = DateTime.UtcNow.AddMinutes(5);
                IsciOzeti(isciler);
            }
            Bekle(2000);
        }

        Yaz("durduruluyor: torna surecleri kapatiliyor");
        foreach (Isci i in isciler) IsciKapat(i);
        Yaz("bekci kapandi");
        return 0;
    }

    /// Backend listesiyle surecleri esitler. @returns liste bu seferde alinabildi mi.
    static bool ListeyiEsitle(string url, List<Isci> isciler, bool oncekiTamam, ref int sira)
    {
        List<string[]> liste = ListeCek(url);
        if (liste == null)
        {
            if (!ListeUyarildi)
            {
                ListeUyarildi = true;
                Yaz(oncekiTamam ? "backend'e ulasilamiyor: calisan surecler oldugu gibi surer, liste tekrar denenecek"
                                : "backend henuz hazir degil: tezgah listesi bekleniyor");
            }
            return false;
        }
        ListeUyarildi = false;
        if (!oncekiTamam) Yaz("tezgah listesi alindi: " + liste.Count + " tezgah");

        Dictionary<string, string> gelen = new Dictionary<string, string>();
        foreach (string[] p in liste) gelen[p[0]] = p[1];

        foreach (Isci i in isciler.ToArray())
        {
            string ip;
            if (!gelen.TryGetValue(i.Id, out ip))
            {
                Yaz(i.Id + ": yapilandirmadan cikarildi, sureci durduruluyor");
                IsciKapat(i);
                isciler.Remove(i);
                continue;
            }
            gelen.Remove(i.Id);
            if (ip != i.Host)
            {
                Yaz(i.Id + ": IP degisti: " + i.Host + " -> " + ip + "; surec yeniden baslatiliyor");
                IsciKapat(i);
                i.Host = ip;
                i.Sonraki = DateTime.UtcNow;
            }
        }
        foreach (KeyValuePair<string, string> kv in gelen)
        {
            Isci yeni = new Isci();
            yeni.Id = kv.Key;
            yeni.Host = kv.Value;
            // Yedi surec ayni anda tornalara baglanmasin: 1,5 sn arayla baslar.
            yeni.Sonraki = DateTime.UtcNow.AddMilliseconds(sira * 1500);
            sira++;
            isciler.Add(yeni);
            Yaz(yeni.Id + ": yeni tezgah (" + yeni.Host + ")");
        }
        return true;
    }

    static void Denetle(Isci i, string exe, string calismaDizini, string temelArgs, int donmaSn, int bostaSn)
    {
        DateTime simdi = DateTime.UtcNow;
        if (i.Surec == null)
        {
            if (simdi >= i.Sonraki) IsciBaslat(i, exe, calismaDizini, temelArgs);
            return;
        }

        bool bitti;
        try { bitti = i.Surec.HasExited; }
        catch { bitti = true; }
        if (bitti)
        {
            string kod;
            try { kod = "cikis kodu 0x" + i.Surec.ExitCode.ToString("X8") + " (" + i.Surec.ExitCode + ")"; }
            catch { kod = "cikis kodu okunamadi"; }
            double omur = (simdi - i.Basladi).TotalSeconds;
            // Hizli tekrarlayan cikislarda bekleme uzar (5 -> 10 -> 20 -> 40 -> 60 sn); en az 60 sn calistiysa sifirlanir.
            i.HizliCikis = omur < 60 ? i.HizliCikis + 1 : 0;
            int bekle = Math.Min(60, 5 << Math.Min(i.HizliCikis > 0 ? i.HizliCikis - 1 : 0, 4));
            Yaz(i.Id + ": ISCI CIKTI: " + kod + "; " + Sure(omur) + " calisti; " + bekle + " sn sonra yeniden baslatilacak");
            i.Surec = null;
            i.Sonraki = simdi.AddSeconds(bekle);
            return;
        }

        double sessiz, ilerlemesiz;
        int esik;
        lock (i.Kilit)
        {
            sessiz = (simdi - i.SonSatir).TotalSeconds;
            ilerlemesiz = (simdi - i.SonIlerleme).TotalSeconds;
            // Ust uste ilerlemesiz yeniden baslatmalarda esik buyur: kapali tornayi bosuna zorlamayalim.
            esik = Math.Max(bostaSn, Math.Min(bostaSn * (1 << Math.Min(i.IlerlemesizSayisi, 3)), 1800));
        }

        if (sessiz > donmaSn)
        {
            IsciYenidenBaslat(i, "ISCI DONMUS: " + donmaSn + " sn'dir hic cikti yok", true);
        }
        else if (ilerlemesiz > esik)
        {
            lock (i.Kilit) i.IlerlemesizSayisi++;
            IsciYenidenBaslat(i, "ILERLEME YOK: " + Sure(ilerlemesiz) + "dir tek okuma yapilamadi (sayac okunan=" + i.Okunan +
                                 "); surecin gunluge yazmasi suruyor, yani surec yasiyor ama tornadan okuyamiyor", true);
        }
    }

    static void IsciYenidenBaslat(Isci i, string neden, bool dokum)
    {
        Yaz(i.Id + ": " + neden);
        string kopuk;
        lock (i.Kilit) kopuk = i.SonKopuk;
        if (kopuk != null) Yaz("  ajanin son bildirdigi durum: " + kopuk);
        if (dokum) IsParcaciklariniYaz(i.Surec);
        SureciKapat(i.Surec, 30000);
        i.Surec = null;
        i.Sonraki = DateTime.UtcNow.AddSeconds(5);
        i.Yeniden++;
        Yaz(i.Id + ": surec sonlandirildi, yeniden baslatilacak (yeniden baslatma sayisi " + i.Yeniden + ")");
    }

    static void IsciBaslat(Isci i, string exe, string calismaDizini, string temelArgs)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(exe, temelArgs + " --host " + Tirnakla(i.Host) + " --machine-id " + Tirnakla(i.Id));
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WorkingDirectory = calismaDizini;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            Process p = Process.Start(psi);
            JoblaBagla(p);

            lock (i.Kilit)
            {
                i.Basladi = DateTime.UtcNow;
                i.SonSatir = i.Basladi;
                i.SonIlerleme = i.Basladi;
                i.Okunan = 0;
                i.SonKopuk = null;
            }
            i.Surec = p;

            // Eski surecin gec kalan satirlari yeni surecin sayaclarini bozmasin: yalnizca GUNCEL surecin ciktisi islenir.
            Isci hedef = i;
            Process kaynak = p;
            p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null && object.ReferenceEquals(hedef.Surec, kaynak)) SatirGeldi(hedef, e.Data);
            };
            p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null && object.ReferenceEquals(hedef.Surec, kaynak)) SatirGeldi(hedef, e.Data);
            };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            Yaz(i.Id + ": surec baslatildi (pid " + p.Id + ", " + i.Host + ")");
        }
        catch (Exception ex)
        {
            Yaz(i.Id + ": surec baslatilamadi: " + ex.Message);
            i.Surec = null;
            i.Sonraki = DateTime.UtcNow.AddSeconds(15);
        }
    }

    /// Torna surecinin bir cikti satiri: kalp atisi + ilerleme (okunan= artti mi) + ortak ajan gunlugune yazim.
    static void SatirGeldi(Isci i, string satir)
    {
        string t = satir.TrimEnd();
        if (t.Trim().Length == 0) return;
        lock (i.Kilit)
        {
            i.SonSatir = DateTime.UtcNow;
            Match m = OkunanRe.Match(t);
            long n;
            if (m.Success && long.TryParse(m.Groups[1].Value, out n) && n > i.Okunan)
            {
                i.Okunan = n;
                i.SonIlerleme = i.SonSatir;
                i.IlerlemesizSayisi = 0;
                i.SonKopuk = null;
            }
            string kisa = t.Trim();
            if (kisa.StartsWith(i.Id + " KOPUK")) i.SonKopuk = kisa;
        }
        string govde = t.TrimStart();
        if (govde.StartsWith(i.Id + " ")) govde = govde.Substring(i.Id.Length + 1);
        AjanLog.WriteLine(govde.StartsWith("[" + i.Id + "]") ? govde : "[" + i.Id + "] " + govde);
    }

    static void IsciKapat(Isci i)
    {
        Process p = i.Surec;
        i.Surec = null; // gec kalan cikti satirlari artik islenmez
        if (p == null) return;
        SureciKapat(p, 5000);
    }

    /// 5 dakikada bir tek satir: her tornanin durumu (uzaktan teshis: hangi torna ne zamandir okuyamiyor).
    static void IsciOzeti(List<Isci> isciler)
    {
        StringBuilder sb = new StringBuilder("isciler:");
        DateTime simdi = DateTime.UtcNow;
        foreach (Isci i in isciler)
        {
            string d;
            lock (i.Kilit)
            {
                if (i.Surec == null) d = "DURDU";
                else
                {
                    double ilerleme = (simdi - i.SonIlerleme).TotalSeconds;
                    d = (i.Okunan > 0 && ilerleme < 180) ? "okuyor" : "OKUMA YOK " + Sure(ilerleme);
                }
                sb.Append(" | ").Append(i.Id).Append(' ').Append(d).Append(" (okunan ").Append(i.Okunan)
                  .Append(", yeniden baslatma ").Append(i.Yeniden).Append(')');
            }
        }
        Yaz(sb.ToString());
    }

    /// "cikti" (alt surec bitti), "donmus" (gunluk durdu) ya da "durdur" (bekci kapaniyor).
    static string Izle(Process alt, DateTime basladi, string logYolu, int donmaSn)
    {
        while (true)
        {
            if (Durdur) return "durdur";

            bool bitti;
            try { bitti = alt.HasExited; }
            catch { bitti = true; }
            if (bitti)
            {
                string kod;
                try { kod = "cikis kodu 0x" + alt.ExitCode.ToString("X8") + " (" + alt.ExitCode + ")"; }
                catch { kod = "cikis kodu okunamadi"; }
                Yaz("AJAN CIKTI: " + kod);
                return "cikti";
            }

            // Kalp atisi: ajanin gunlugunun son yazim zamani. Dosya yoksa (ya da eskiyse)
            // ajanin baslama anindan sayilir: baslik satirini hemen yazmasi gerekir.
            DateTime son = DateTime.MinValue;
            try { if (File.Exists(logYolu)) son = File.GetLastWriteTimeUtc(logYolu); }
            catch { }
            DateTime olcut = son > basladi ? son : basladi;
            double sessizlik = (DateTime.UtcNow - olcut).TotalSeconds;
            if (sessizlik > donmaSn) return "donmus";

            Bekle(2000);
        }
    }

    /// Donmus surecin neyi bekledigini gunluge yazar: 2 sn arayla iki olcum, hangi is
    /// parcacigi CPU yiyor (dongude mi?), hangileri hangi nedenle bekliyor.
    static void IsParcaciklariniYaz(Process alt)
    {
        try
        {
            alt.Refresh();
            Yaz("  pid " + alt.Id + ": " + alt.Threads.Count + " is parcacigi, " + alt.HandleCount +
                " tutamac, " + (alt.WorkingSet64 / 1048576) + " MB, toplam CPU " +
                alt.TotalProcessorTime.TotalSeconds.ToString("0.0") + " sn");

            Dictionary<int, double> once = CpuDokumu(alt);
            Thread.Sleep(2000);
            alt.Refresh();

            int yazilan = 0;
            Dictionary<string, int> durumlar = new Dictionary<string, int>();
            foreach (ProcessThread t in alt.Threads)
            {
                string durum = t.ThreadState.ToString();
                if (t.ThreadState == System.Diagnostics.ThreadState.Wait)
                {
                    try { durum += "/" + t.WaitReason; } catch { }
                }
                int say;
                durumlar[durum] = durumlar.TryGetValue(durum, out say) ? say + 1 : 1;

                double toplam = 0, fark = 0;
                try
                {
                    toplam = t.TotalProcessorTime.TotalSeconds;
                    double onceki;
                    if (once.TryGetValue(t.Id, out onceki)) fark = toplam - onceki;
                }
                catch { }
                // Her is parcacigini dokme: yalnizca CPU yiyenleri ve ilk birkacini yaz.
                if (fark > 0.05 || yazilan < 3)
                {
                    Yaz("  is parcacigi " + t.Id + ": " + durum + ", CPU " + toplam.ToString("0.00") +
                        " sn (son 2 sn'de +" + fark.ToString("0.00") + ")");
                    yazilan++;
                }
            }
            StringBuilder ozet = new StringBuilder("  durum dagilimi:");
            foreach (KeyValuePair<string, int> kv in durumlar) ozet.Append(" ").Append(kv.Key).Append("=").Append(kv.Value);
            Yaz(ozet.ToString());
        }
        catch (Exception ex)
        {
            Yaz("  surec bilgisi alinamadi: " + ex.Message);
        }
    }

    static Dictionary<int, double> CpuDokumu(Process alt)
    {
        Dictionary<int, double> d = new Dictionary<int, double>();
        foreach (ProcessThread t in alt.Threads)
        {
            try { d[t.Id] = t.TotalProcessorTime.TotalSeconds; } catch { }
        }
        return d;
    }

    /// Alt sureci gerekirse zorla sonlandirir ve gercekten bittigini bekler.
    static void SureciKapat(Process alt, int beklemeMs)
    {
        try
        {
            // Durdur ile geldiysek ajan Ctrl+C'yi kendisi de aldi ve tezgah oturumlarini
            // duzgun kapatiyor olabilir: once bekle. Donmus surec icin beklemeMs sonra zorla.
            if (Durdur && alt.WaitForExit(beklemeMs)) return;
            if (!alt.HasExited)
            {
                try { alt.Kill(); } catch (Exception ex) { Yaz("  Kill basarisiz: " + ex.Message); }
            }
            if (!alt.WaitForExit(30000))
                Yaz("  UYARI: sonlandirilan surec 30 sn'de bitmedi (pid " + alt.Id + "); yenisi yine de baslatilacak");
        }
        catch (Exception ex)
        {
            Yaz("  surec kapatilamadi: " + ex.Message);
        }
    }

    // ------------------------------------------------------------------ job nesnesi

    static IntPtr IsKur()
    {
        try
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) { Yaz("job nesnesi kurulamadi (hata " + Marshal.GetLastWin32Error() + ")"); return IntPtr.Zero; }

            JobGenis bilgi = new JobGenis();
            bilgi.Temel.LimitFlags = KILL_ON_JOB_CLOSE;
            int boy = Marshal.SizeOf(typeof(JobGenis));
            IntPtr p = Marshal.AllocHGlobal(boy);
            try
            {
                Marshal.StructureToPtr(bilgi, p, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, p, (uint)boy))
                {
                    Yaz("job siniri ayarlanamadi (hata " + Marshal.GetLastWin32Error() + ")");
                    return IntPtr.Zero;
                }
            }
            finally { Marshal.FreeHGlobal(p); }
            return job;
        }
        catch (Exception ex)
        {
            Yaz("job nesnesi kullanilamiyor: " + ex.Message);
            return IntPtr.Zero;
        }
    }

    /// Alt sureci job'a baglar. Basarisiz olursa (ornegin eski Windows'ta bekci zaten baska bir
    /// job'un icindeyse) yalnizca uyarir: bekci oldurulurse alt surec yetim kalabilir, bu durumda
    /// Gorev Zamanlayici gorevi durdururken tum sureci zaten sonlandirir.
    static void JoblaBagla(Process alt)
    {
        if (Job == IntPtr.Zero) return;
        try
        {
            if (!AssignProcessToJobObject(Job, alt.Handle))
                Yaz("UYARI: alt surec job'a baglanamadi (hata " + Marshal.GetLastWin32Error() +
                    "); bekci oldurulurse ajan yetim kalabilir");
        }
        catch (Exception ex)
        {
            Yaz("UYARI: job baglama hatasi: " + ex.Message);
        }
    }

    // ------------------------------------------------------------------ yardimcilar

    /// Alt surecin komut satiri: bekcinin kendi bayraklari (--supervise, --stale-sec, --idle-sec, --list-sec, --tek-surec) cikarilir.
    /// --log yalniz TEK SUREC kipinde alt surece gider; torna basina surec kipinde ciktiyi bekci yazar (iki surec ayni dosyaya yazmasin).
    static string AltArgumanlar(string[] argv, bool logDahil)
    {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < argv.Length; i++)
        {
            string a = argv[i];
            bool atla = a == "--supervise" || a == "--stale-sec" || a == "--idle-sec" || a == "--list-sec" || a == "--tek-surec" ||
                        (!logDahil && a == "--log");
            if (atla)
            {
                if (i + 1 < argv.Length && !argv[i + 1].StartsWith("--")) i++; // degerini de atla
                continue;
            }
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(Tirnakla(a));
        }
        return sb.ToString();
    }

    static string Tirnakla(string s)
    {
        if (s.Length > 0 && s.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return s;
        return "\"" + s.Replace("\"", "\\\"") + "\"";
    }

    static string Sure(double sn)
    {
        if (sn < 120) return ((int)sn) + " sn";
        if (sn < 7200) return ((int)(sn / 60)) + " dk";
        return (sn / 3600).ToString("0.0") + " sa";
    }

    static void Yaz(string metin)
    {
        // Tarih-saati DosyaYazici her satirin basina kendisi ekler.
        Console.WriteLine("[bekci] " + metin);
    }

    /// Kapanma istegine duyarli bekleme.
    static void Bekle(int ms)
    {
        while (ms > 0 && !Durdur)
        {
            int bu = ms < 200 ? ms : 200;
            Thread.Sleep(bu);
            ms -= bu;
        }
    }
}
