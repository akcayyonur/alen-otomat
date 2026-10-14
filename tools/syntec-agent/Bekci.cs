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
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

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
            Console.WriteLine("[bekci] --supervise icin --log <dosya> gerekli (donma, ajanin gunlugunun durmasindan anlasilir)");
            return 1;
        }
        logYolu = Path.GetFullPath(logYolu);

        int donmaSn = VarsayilanDonmaSn;
        string deger;
        if (arg.TryGetValue("stale-sec", out deger)) int.TryParse(deger, out donmaSn);
        if (donmaSn < 15) donmaSn = 15;

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
        string altArgs = AltArgumanlar(argv);

        Job = IsKur();
        Yaz("bekci basladi (pid " + Process.GetCurrentProcess().Id + "); alt surec: " + exe + " " + altArgs);
        Yaz("donma siniri: ajan gunlugu " + donmaSn + " sn degismezse yeniden baslatilir (" + logYolu + ")");

        Thread izleyici = new Thread(DuraklamaIzle);
        izleyici.IsBackground = true;
        izleyici.Name = "duraklama-izle";
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

    /// Alt surecin komut satiri: bekcinin kendi bayraklari (--supervise, --stale-sec) cikarilir.
    static string AltArgumanlar(string[] argv)
    {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < argv.Length; i++)
        {
            string a = argv[i];
            if (a == "--supervise" || a == "--stale-sec")
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
