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
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Syntec.Telemetri;

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
    }

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

        IngestUrl = Get(arg, "ingest", "http://127.0.0.1:3000/api/ingest");
        DllYolu = Get(arg, "dll", "Syntec.RemoteCNC.Win32.dll");
        AralikMs = int.Parse(Get(arg, "interval", "1000"));
        YenidenDenemeMs = int.Parse(Get(arg, "retry", "10000"));
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

        // Kapanirken kalan tamponu gondermeyi dene.
        Gonder();
        Console.WriteLine("[ajan] okunan " + ToplamOkunan + ", gonderilen " + ToplamGonderilen +
                          ", dusen " + ToplamDusen);
        return 0;
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
                    string h = t.Okuyucu.YenidenBaglan(DllYolu);
                    if (h != null && h != t.SonHata)
                    {
                        t.SonHata = h;
                        Console.WriteLine("[" + t.Id + "] baglanamadi: " + h);
                    }
                    Bekle(YenidenDenemeMs);
                    continue;
                }
            }

            try
            {
                Dictionary<string, object> d = t.Okuyucu.Oku();
                if (d.Count == 0)
                {
                    // Hicbir fonksiyon donmedi - baglanti kopmus say.
                    t.Bagli = false;
                    Console.WriteLine("[" + t.Id + "] yanit yok, yeniden baglanilacak");
                    continue;
                }

                Kuyrukla(t.Okuyucu.TelemetriJson(d));
                t.Okunan++;
                t.SonBasari = DateTime.Now;
                Interlocked.Increment(ref ToplamOkunan);
            }
            catch (Exception ex)
            {
                t.Bagli = false;
                Console.WriteLine("[" + t.Id + "] okuma hatasi: " + SyntecReader.Kok(ex).Message);
            }

            Bekle(AralikMs);
        }

        if (t.Dur) Console.WriteLine("[" + t.Id + "] okuma durduruldu");
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
        Console.WriteLine("  --ingest <url>       backend adresi");
        Console.WriteLine("  --interval <ms>      okuma araligi (varsayilan 1000)");
        Console.WriteLine("  --retry <ms>         yeniden baglanma araligi (varsayilan 10000)");
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
