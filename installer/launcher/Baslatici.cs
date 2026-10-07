// CNC Telemetri baslatici - masaustu uygulamasi.
//
// Acinca: backend ve ajan calisiyor mu bakar. Calismiyorsa Gorev Zamanlayici'daki
// iki gorevi baslatir (acilista zaten kendiliginden baslarlar; bu, durmus ya da
// elle kapatilmis olanlari tek tikla kaldirmak icindir) ve backend hazir olunca
// dashboard'u tarayicida acar.
//
// Normal durumda (ikisi de calisiyor) pencere de yonetici izni de gerekmez:
// dogrudan dashboard acilir. Gorevleri baslatmak yonetici yetkisi ister
// (gorevler SYSTEM hesabinda calisir); o yalnizca gerektiginde, UAC ile istenir.
//
// Bayraklar (testler ve betikler icin):
//   --sessiz     pencere ve tarayici yok; sonuc yalnizca cikis koduyla
//   --denetle    yalniz backend saglikli mi bakar (0 = evet, 1 = hayir), baska
//                hicbir sey yapmaz
//   --port N     dashboard portu (varsayilan 3000)
//   --yonetici   (dahili) yukseltilmis kopya: yalniz gorevleri baslatir
//
// Cikis kodlari:
//   0 tamam   1 backend yok (--denetle)   3 gorevler kayitli degil
//   4 gorevler baslatilamadi   5 baslatilamadi (izin gerekebilir; --sessiz)
//   6 yonetici izni verilmedi   7 backend zamaninda kalkmadi
//   8 ajan calismiyor (dashboard yine de acilir)
//
// Hedef: .NET Framework 4.x. Syntec DLL'lerini YUKLEMEZ, bu yuzden x86 olmasi
// gerekmez.

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

// Surum bilgisi: dosyanin ozelliklerinde yayinci/urun/aciklama gorunsun.
[assembly: AssemblyTitle("CNC Telemetri")]
[assembly: AssemblyDescription("CNC Telemetri hizmetlerini baslatir ve dashboard'u acar")]
[assembly: AssemblyCompany("alen-otomat")]
[assembly: AssemblyProduct("CNC Telemetri")]
[assembly: AssemblyVersion("0.1.6.0")]
[assembly: AssemblyFileVersion("0.1.6.0")]

static class Baslatici
{
    const string BackendGorev = "CNC Telemetri - Backend";
    const string AjanGorev = "CNC Telemetri - Edge Agent";
    const int BackendBeklemeSn = 60;
    const int AjanBeklemeSn = 10;

    static int Port = 3000;
    static bool Sessiz;

    // Arka plan is parcaciginin pencereye bildirdigi durum.
    static volatile string Durum = "Hizmetler kontrol ediliyor...";
    static volatile bool Bitti;
    static int Sonuc = -1;

    [STAThread]
    static int Main(string[] argv)
    {
        bool denetle = false, yonetici = false;
        for (int i = 0; i < argv.Length; i++)
        {
            switch (argv[i])
            {
                case "--sessiz": Sessiz = true; break;
                case "--denetle": denetle = true; break;
                case "--yonetici": yonetici = true; break;
                case "--port":
                    int p;
                    if (i + 1 < argv.Length && int.TryParse(argv[i + 1], out p)) { Port = p; i++; }
                    break;
            }
        }

        if (denetle) return Saglikli() ? 0 : 1;
        // Yukseltilmis kopya kilit almaz: kilidi onu baslatan ust kopya tutuyor.
        if (yonetici) return GorevleriBaslat(true);

        // Ust uste tiklamada iki bekleme penceresi acilmasin.
        bool yeni;
        using (new Mutex(true, "CncTelemetriBaslatici", out yeni))
        {
            if (!yeni) return 0;
            return Calistir();
        }
    }

    static int Calistir()
    {
        // Hizli yol: ikisi de ayakta, dogrudan dashboard.
        if (Saglikli() && AjanCalisiyor())
        {
            if (!Sessiz) Ac();
            return 0;
        }

        if (Sessiz) return HizmetleriAyaktaTut();

        Thread is_ = new Thread(delegate() { Sonuc = HizmetleriAyaktaTut(); Bitti = true; });
        is_.IsBackground = true;
        is_.Start();
        BeklemePenceresi();

        // Pencere is bitmeden kapatildiysa sessizce cik: bir seyin sonucunu
        // bilmeden hata gostermeyiz.
        if (!Bitti) return 0;
        SonucuGoster(Sonuc);
        return Sonuc;
    }

    /// Ikisini de ayaga kaldirir, backend hazir olunca dashboard'u acar.
    static int HizmetleriAyaktaTut()
    {
        if (!Saglikli() || !AjanCalisiyor())
        {
            Durum = "Hizmetler başlatılıyor...";
            int rc = GorevleriBaslat(false);
            // Normal kullanicinin izni yok: yalnizca simdi yonetici izni iste.
            if (rc == 5 && !Sessiz) rc = YukseltilmisBaslat();
            if (rc != 0) return rc;
        }

        Durum = "Backend hazırlanıyor...";
        if (!Bekle(Saglikli, BackendBeklemeSn)) return 7;

        Durum = "Tezgah ajanı kontrol ediliyor...";
        bool ajanTamam = Bekle(AjanCalisiyor, AjanBeklemeSn);

        if (!Sessiz) Ac();
        return ajanTamam ? 0 : 8;
    }

    /// Iki gorevi Gorev Zamanlayici'dan calistirir.
    ///  - normal kopya: yalniz dener; basarisizsa 5 (izin yok VE kayitli degil
    ///    ayirt edilemez, yukseltilmis kopya ayirir)
    ///  - yukseltilmis kopya: kayitli degilse 3, baslatilamazsa 4
    static int GorevleriBaslat(bool yukseltilmis)
    {
        string[] gorevler = { BackendGorev, AjanGorev };

        if (yukseltilmis)
        {
            foreach (string g in gorevler)
                if (Komut("schtasks.exe", "/Query /TN \"" + g + "\"") != 0) return 3;
        }
        foreach (string g in gorevler)
        {
            // Zaten calisan gorevde /Run zararsizdir (ikinci kopya acilmaz).
            if (Komut("schtasks.exe", "/Run /TN \"" + g + "\"") != 0)
                return yukseltilmis ? 4 : 5;
        }
        return 0;
    }

    /// Kendini yonetici olarak yeniden baslatir (UAC), sonucunu bekler.
    static int YukseltilmisBaslat()
    {
        Durum = "Yönetici izni isteniyor...";
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(Application.ExecutablePath,
                "--yonetici --port " + Port);
            psi.Verb = "runas";
            psi.UseShellExecute = true;
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Win32Exception ex)
        {
            return ex.NativeErrorCode == 1223 ? 6 : 4; // 1223: kullanici UAC'yi iptal etti
        }
    }

    // ------------------------------------------------------------- denetimler

    /// Backend cevap veriyor mu. Proxy KAPALI: kurumsal bir proxy, yerel adrese
    /// giderken bile (502 Bad Gateway) yanlis sonuc verebiliyor.
    static bool Saglikli()
    {
        try
        {
            HttpWebRequest r = (HttpWebRequest)WebRequest.Create(
                "http://127.0.0.1:" + Port + "/api/health");
            r.Timeout = 1500;
            r.Proxy = null;
            using (HttpWebResponse y = (HttpWebResponse)r.GetResponse())
            using (StreamReader o = new StreamReader(y.GetResponseStream()))
                return o.ReadToEnd().Contains("\"ok\":true");
        }
        catch { return false; }
    }

    static bool AjanCalisiyor()
    {
        return Process.GetProcessesByName("syntec-agent").Length > 0;
    }

    static bool Bekle(Func<bool> kosul, int saniye)
    {
        DateTime son = DateTime.Now.AddSeconds(saniye);
        while (DateTime.Now < son)
        {
            if (kosul()) return true;
            Thread.Sleep(500);
        }
        return kosul();
    }

    /// Programi gizli calistirir, cikis kodunu dondurur (cikti okunup atilir).
    static int Komut(string dosya, string arguman)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(dosya, arguman);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            using (Process p = Process.Start(psi))
            {
                p.StandardOutput.ReadToEnd();
                p.StandardError.ReadToEnd();
                if (!p.WaitForExit(20000)) { try { p.Kill(); } catch { } return -1; }
                return p.ExitCode;
            }
        }
        catch { return -1; }
    }

    static void Ac()
    {
        try { Process.Start("http://localhost:" + Port); }
        catch { /* varsayilan tarayici yoksa yapilacak bir sey yok */ }
    }

    // --------------------------------------------------------------- arayuz

    static void BeklemePenceresi()
    {
        Application.EnableVisualStyles();

        Form f = new Form();
        f.Text = "CNC Telemetri";
        f.ClientSize = new Size(380, 92);
        f.FormBorderStyle = FormBorderStyle.FixedDialog;
        f.MaximizeBox = false;
        f.MinimizeBox = false;
        f.StartPosition = FormStartPosition.CenterScreen;
        try { f.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        Label l = new Label();
        l.Text = Durum;
        l.AutoSize = false;
        l.Left = 16; l.Top = 16; l.Width = 348; l.Height = 24;
        l.Font = new Font(SystemFonts.MessageBoxFont.FontFamily, 10f);
        f.Controls.Add(l);

        ProgressBar pb = new ProgressBar();
        pb.Style = ProgressBarStyle.Marquee;
        pb.MarqueeAnimationSpeed = 30;
        pb.Left = 16; pb.Top = 52; pb.Width = 348; pb.Height = 18;
        f.Controls.Add(pb);

        System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
        t.Interval = 200;
        t.Tick += delegate { l.Text = Durum; if (Bitti) f.Close(); };
        t.Start();

        Application.Run(f);
    }

    static void SonucuGoster(int kod)
    {
        string log = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "logs");
        string metin;
        MessageBoxIcon simge = MessageBoxIcon.Error;

        switch (kod)
        {
            case 0: return;
            case 3:
                metin = "CNC Telemetri hizmetleri bu bilgisayarda kayıtlı değil.\n\n" +
                        "Kurulumu yeniden çalıştırın.";
                break;
            case 4:
            case 5:
                metin = "Hizmetler başlatılamadı.\n\nAyrıntı: " + Path.Combine(log, "kurulum.log");
                break;
            case 6:
                metin = "Yönetici izni verilmedi, hizmetler başlatılamadı.\n\n" +
                        "Uygulamayı yeniden açıp izin verin.";
                simge = MessageBoxIcon.Warning;
                break;
            case 7:
                metin = "Backend " + BackendBeklemeSn + " saniyede başlamadı.\n\n" +
                        "Ayrıntı: " + Path.Combine(log, "backend.log");
                break;
            case 8:
                metin = "Dashboard açıldı ancak tezgah ajanı çalışmıyor; tezgahlardan veri gelmeyecek.\n\n" +
                        "Ayrıntı: " + Path.Combine(log, "ajan.log");
                simge = MessageBoxIcon.Warning;
                break;
            default:
                metin = "Beklenmeyen hata (kod " + kod + ").";
                break;
        }
        MessageBox.Show(metin, "CNC Telemetri", MessageBoxButtons.OK, simge);
    }
}
