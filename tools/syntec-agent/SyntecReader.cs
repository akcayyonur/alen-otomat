// Syntec RemoteAPI okuma katmani - probe ve agent'in ORTAK kodu.
//
// Durum eslemesi ve alan eslemesi YALNIZCA burada tanimli. Iki ayri kopya
// olsaydi biri guncellenip digeri unutulur ve saha araci ile uretim ajani
// farkli sonuc uretirdi; ikisi de bu dosyayi derler.
//
// Metotlar yansimayla cagriliyor: ByRef parametrelerin out mu ref mi oldugu
// metadata'dan ayirt edilemiyor ve surumler arasi imza degisebiliyor; yansima
// ikisinde de calisir.
//
// Hedef: .NET Framework 4.0 / C# 4.0 (csc.exe v4.0.30319). Yeni dil
// ozellikleri (string interpolation, ?., nameof) KULLANILMAZ.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

namespace Syntec.Telemetri
{
    /// Tek bir kontrolcuye bagli okuyucu.
    public class SyntecReader
    {
        public readonly string Host;
        public readonly string MakineId;

        Type _type;
        object _cnc;

        /// Hangi fonksiyon kac kez basarili oldu - yetenek raporu icin.
        public readonly Dictionary<string, int> Basarili = new Dictionary<string, int>();
        public readonly Dictionary<string, string> SonHata = new Dictionary<string, string>();

        /// Durum eslemesinde taninmayan ham degerler. Sessizce IDLE'a esleme
        /// yapilir ama deger burada birikir ve raporlanir.
        public readonly HashSet<string> BilinmeyenDurum = new HashSet<string>();

        public static readonly string[] Fonksiyonlar = {
            "READ_status", "READ_spindle", "READ_part_count", "READ_time",
            "READ_alm_current", "READ_nc_current_block"
        };

        public SyntecReader(string host, string makineId)
        {
            Host = host;
            MakineId = makineId;
        }

        // ------------------------------------------------- kontrolcu modeli / istemci DLL'i
        //
        // Ayni SyntecRemoteCNC sinifi iki Syntec paketinde de var, ama farkli DLL'de:
        //   11TB (paket 10.116.x): Syntec.RemoteCNC.Win32.dll   ayri yonetilen sarmalayici
        //   22TB (paket 10.118.x): Syntec.OpenCNC.dll           sinif bu DLL'in icine tasinmis
        // Okuma yontemlerinin imzalari ikisinde de birebir ayni (yansimayla karsilastirildi,
        // 22B simulatorunde 5 okuma calisti), yani okuma kodu degismez; yalniz hangi DLL'in
        // yuklenecegi degisir. Iki paketin yerel (native) DLL'leri ayni adi tasidigi icin ayni
        // surecte birlikte yuklenemez: her model icin AYRI ajan sureci, kendi paketinin
        // Bin klasorunden calisir.
        public const string DllOnbirTB = "Syntec.RemoteCNC.Win32.dll";
        public const string DllYirmiikiTB = "Syntec.OpenCNC.dll";

        /// Model adindan ("11TB" / "22TB", buyuk-kucuk harf fark etmez) istemci DLL'i; taninmayan model icin null.
        public static string ModelDll(string model)
        {
            switch ((model ?? "").Trim().ToUpperInvariant())
            {
                case "11TB": return DllOnbirTB;
                case "22TB": return DllYirmiikiTB;
                default: return null;
            }
        }

        /// DLL adindan model. 11B paketinde de bir Syntec.OpenCNC.dll var (sinifi icermez),
        /// bu yuzden 11TB DLL'i once aranir: ad "RemoteCNC" iceriyorsa 11TB, degilse 22TB.
        public static string DllModeli(string dllYolu)
        {
            string ad = Path.GetFileName(dllYolu ?? "");
            return ad.IndexOf("RemoteCNC", StringComparison.OrdinalIgnoreCase) >= 0 ? "11TB" : "22TB";
        }

        /// Klasorde bulunan pakete gore varsayilan DLL: 11TB'nin ayri DLL'i varsa o, yoksa 22TB'nin
        /// (ikisi de yoksa 11TB adi: hata mesaji "DLL yuklenemedi" bunu gosterir).
        public static string VarsayilanDll(string dizin)
        {
            if (File.Exists(Path.Combine(dizin, DllOnbirTB))) return DllOnbirTB;
            if (File.Exists(Path.Combine(dizin, DllYirmiikiTB))) return DllYirmiikiTB;
            return DllOnbirTB;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr LoadLibraryEx(string dosya, IntPtr hFile, uint bayraklar);
        const uint LOAD_WITH_ALTERED_SEARCH_PATH = 0x8;

        /// Syntec'in native DLL'i (OCApi.dll) bu bilgisayarda yuklenebiliyor mu.
        /// Yuklenemiyorsa NEDENI anlatan bir mesaj doner, yukleniyorsa null.
        ///
        /// Neden ayri bir denetim: eksik bir calisma zamani (ornegin Visual C++
        /// 2005) yuzunden DLL yuklenemediginde Syntec'in kutuphanesi hata FIRLATMAZ,
        /// yalnizca isConnected() false doner - ajan sebepsiz "KOPUK" der ve saatlerce
        /// ag/guvenlik duvari aranir (sahada yasandi, hata 0x800736B1).
        ///
        /// Syntec tiplerine dokunmadan ONCE cagrilmali: bir .NET tipinin statik
        /// baslaticisi (OcApiTCP) bir kez cokerse surec yeniden baslayana kadar
        /// bir daha calismaz; calisma zamani sonradan kurulsa bile.
        public static string NativeKontrol(string dllYolu)
        {
            string dizin = Path.GetDirectoryName(Path.GetFullPath(dllYolu));
            string ocapi = Path.Combine(dizin, "OCApi.dll");
            // Bu paket degil (ornegin test sahtesi): denetlenecek native DLL yok.
            if (!File.Exists(ocapi)) return null;

            // Basarili yuklemeyi serbest BIRAKMIYORUZ: Syntec kutuphanesi ayni DLL'i
            // zaten yukleyecek, ayni modulu yeniden kullanir.
            if (LoadLibraryEx(ocapi, IntPtr.Zero, LOAD_WITH_ALTERED_SEARCH_PATH) != IntPtr.Zero)
                return null;

            int kod = Marshal.GetLastWin32Error();
            switch (kod)
            {
                case 14001: // ERROR_SXS_CANT_GEN_ACTCTX (0x800736B1): eksik yan yana (SxS) bagimlilik
                    return "Syntec DLL'i (OCApi.dll) yuklenemedi: bu bilgisayarda Microsoft Visual C++ " +
                           "2005 SP1 (x86) calisma zamani yok (hata 14001, yan yana yapilandirma). " +
                           "Kur: vcredist_x86.exe - https://www.microsoft.com/en-us/download/details.aspx?id=26347 " +
                           "- kurulduktan sonra ajan gorevini yeniden baslat.";
                case 193: // ERROR_BAD_EXE_FORMAT
                    return "OCApi.dll 32-bit, ama ajan 32-bit degil calisiyor (hata 193). " +
                           "Ajan /platform:x86 ile derlenmeli.";
                case 126: // ERROR_MOD_NOT_FOUND
                case 127: // ERROR_PROC_NOT_FOUND
                    return "OCApi.dll'in bagimli oldugu bir dosya bulunamadi (hata " + kod + "). " +
                           "Syntec Bin klasoru eksiksiz mi?";
                default:
                    return "Syntec DLL'i (OCApi.dll) yuklenemedi (hata " + kod + "): " +
                           new Win32Exception(kod).Message;
            }
        }

        /// DLL'i yukler ve kontrolcu nesnesini olusturur. Hata mesaji doner (null = basarili).
        public string Baglan(string dllYolu)
        {
            Assembly asm;
            try
            {
                asm = Assembly.LoadFrom(System.IO.Path.GetFullPath(dllYolu));
            }
            catch (Exception ex)
            {
                return "DLL yuklenemedi: " + ex.Message +
                       " (bu programi Syntec dll'lerinin yanindaki klasorden calistir)";
            }

            _type = asm.GetType("Syntec.Remote.SyntecRemoteCNC");
            if (_type == null) return "SyntecRemoteCNC tipi bulunamadi";

            try
            {
                _cnc = Activator.CreateInstance(_type, new object[] { Host });
            }
            catch (Exception ex)
            {
                return "nesne olusturulamadi: " + Kok(ex).Message;
            }
            return null;
        }

        public bool BaglantiVar()
        {
            if (_cnc == null) return false;
            try { return (bool)_type.GetMethod("isConnected").Invoke(_cnc, null); }
            catch { return false; }
        }

        /// Oturumu DUZGUN kapatir: once Close(), sonra Dispose(). Ikisi de yoksa/hata verirse sessiz.
        ///
        /// Bunu yapmadan nesneyi birakmak, torna tarafinda oturumu acik birakir: Syntec
        /// kutuphanesi (SyntecRemoteCNC IDisposable) kapanisi yalnizca cop toplayicinin
        /// Finalize'ina birakir. Her yeniden baglanmada bir oturum sizarsa, tornanin API
        /// sunucusu zamanla tikanabilir. (Eskiden burada "DisConnect"/"Disconnect" aranirdi;
        /// bu adda bir metot YOK, kapatma hic yapilmiyordu.)
        ///
        /// Cagri takili olabilir (sunucu cevap vermiyorsa Close da bekler): cagiran, bunu
        /// zaman asimli bir is parcaciginda calistirmali (bkz. Agent.KapatArkaPlanda).
        public void Kapat()
        {
            object cnc = _cnc;
            if (cnc == null) return;
            try
            {
                MethodInfo kapat = _type.GetMethod("Close", Type.EmptyTypes);
                if (kapat != null) kapat.Invoke(cnc, null);
            }
            catch { }
            try
            {
                IDisposable d = cnc as IDisposable;
                if (d != null) d.Dispose();
            }
            catch { }
        }

        /// Baglanti koptuysa ESKI OTURUMU KAPATIP yeniden kurar.
        public string YenidenBaglan(string dllYolu)
        {
            try { Kapat(); }
            catch { /* kapatirken hata onemli degil, zaten yeniden kuruyoruz */ }

            _cnc = null;
            try
            {
                _cnc = Activator.CreateInstance(_type, new object[] { Host });
            }
            catch (Exception ex)
            {
                return Kok(ex).Message;
            }
            return null;
        }

        /// Kimlik bilgileri - ilk baglantida bir kez yazdirilir.
        public Dictionary<string, object> Kimlik()
        {
            var d = new Dictionary<string, object>();
            foreach (string ad in new[] { "SeriesNo", "MainBoardPlatformName", "CncOption" })
            {
                try
                {
                    MethodInfo m = _type.GetMethod("get_" + ad);
                    if (m != null) d[ad] = m.Invoke(_cnc, null);
                }
                catch (Exception ex) { d[ad] = "HATA " + Kok(ex).Message; }
            }

            object[] a = { (short)0, null, (short)0, null, null, null };
            if (Cagir("READ_information", a) == 0)
            {
                d["EksenSayisi"] = a[0];
                d["CncType"] = a[1];
                d["AzamiEksen"] = a[2];
                d["Seri"] = a[3];
                d["NcSurum"] = a[4];
            }
            return d;
        }

        /// Tum okuma fonksiyonlarini cagirip ham alanlari bir sozluge doldurur.
        public Dictionary<string, object> Oku()
        {
            var d = new Dictionary<string, object>();

            object[] st = { null, null, 0, null, null, null, null };
            if (Cagir("READ_status", st) == 0)
            {
                d["MainProg"] = st[0]; d["CurProg"] = st[1]; d["CurSeq"] = st[2]; d["Mode"] = st[3];
                d["Status"] = st[4]; d["Alarm"] = st[5]; d["EMG"] = st[6];
            }

            object[] sp = { 0f, 0f, 0f, 0 };
            if (Cagir("READ_spindle", sp) == 0)
            {
                d["OvFeed"] = sp[0]; d["OvSpindle"] = sp[1]; d["ActFeed"] = sp[2]; d["ActSpindle"] = sp[3];
            }

            object[] pc = { 0, 0, 0 };
            if (Cagir("READ_part_count", pc) == 0)
            {
                d["PartCount"] = pc[0]; d["RequiredPart"] = pc[1]; d["TotalPartCount"] = pc[2];
            }

            object[] tm = { 0, 0, 0, 0 };
            if (Cagir("READ_time", tm) == 0)
            {
                d["PowerOnTime"] = tm[0]; d["AccumCutTime"] = tm[1];
                d["CycleTimeSec"] = tm[2]; d["WorkTime"] = tm[3];
            }

            object[] al = { false, null, null };
            if (Cagir("READ_alm_current", al) == 0)
            {
                d["IsAlarm"] = al[0]; d["AlmMsg"] = al[1];
            }

            object[] blk = { null };
            if (Cagir("READ_nc_current_block", blk) == 0) d["Block"] = blk[0];

            return d;
        }

        /// Metodu yansimayla cagirir; donus kodu 0 ise basarili sayilir.
        public short Cagir(string ad, object[] args)
        {
            try
            {
                MethodInfo[] yontemler = _type.GetMethods()
                    .Where(x => x.Name == ad && x.GetParameters().Length == args.Length).ToArray();
                if (yontemler.Length == 0) { SonHata[ad] = "metot yok"; return -1; }

                short rc = (short)yontemler[0].Invoke(_cnc, args);
                if (rc == 0)
                {
                    int n;
                    Basarili[ad] = Basarili.TryGetValue(ad, out n) ? n + 1 : 1;
                }
                else SonHata[ad] = "rc=" + rc;
                return rc;
            }
            catch (Exception ex)
            {
                SonHata[ad] = Kok(ex).Message;
                return -1;
            }
        }

        // ---------------------------------------------------------------- esleme

        /// Ham kontrolcu durumunu normalize duruma cevirir.
        ///
        /// Gercek tezgahta gozlenen degerler (192.168.88.99, 2026-09-18 16:35,
        /// tezgah keserken, 104 ornek):
        ///     Status="START"  Alarm="****"  EMG="****"   -> RUNNING
        /// PC Simulator'da tezgah bostayken:
        ///     Status="READY"                             -> IDLE
        /// Alarm/EMG alanlari olay yokken "****" doner, varken "ALARM" / "EMG".
        ///
        /// Taninmayan deger sessizce eslenmez: BilinmeyenDurum'a yazilir, ajan
        /// bunu loga basar ve ham deger her mesajda controller.rawStatus olarak
        /// tasinir - esleme ofisten dogrulanabilsin diye.
        public string DurumEsle(Dictionary<string, object> d)
        {
            string s = Convert.ToString(Al(d, "Status")).Trim().ToUpperInvariant();
            string a = Convert.ToString(Al(d, "Alarm")).Trim().ToUpperInvariant();
            string e = Convert.ToString(Al(d, "EMG")).Trim().ToUpperInvariant();

            if (e == "EMG" || a == "ALARM") return "ALARM";

            // "NOTREADY" icinde "READY" gectigi icin asagidaki IDLE eslemesine
            // dusmesin: "hazir degil" bostalik demek degil. Gozlendigi tek yer
            // 192.168.88.99'dur ve orada tezgah uretim yaparken donuyordu (sunucu
            // cekirdekle yarim eslesmis) - yani guvenilir bir durum bilgisi degil.
            // Tanimsiz sayilir: loga ve controller.rawStatus'a dusur, IDLE'a
            // sessizce esleme.
            if (s.Replace("_", "").Replace(" ", "").StartsWith("NOT"))
            {
                BilinmeyenDurum.Add(s);
                return "IDLE";
            }

            if (s.Contains("RUN") || s.Contains("START") || s.Contains("BUSY") || s.Contains("CYCLE"))
                return "RUNNING";
            if (s.Contains("READY") || s.Contains("STOP") || s.Contains("PAUSE") ||
                s.Contains("HOLD") || s.Contains("IDLE") || s.Contains("RESET"))
                return "IDLE";

            if (s.Length > 0) BilinmeyenDurum.Add(s);
            return "IDLE";
        }

        /// Backend'in bekledigi normalize telemetri mesaji (shared/schema.js).
        public string TelemetriJson(Dictionary<string, object> d)
        {
            var j = new StringBuilder();
            j.Append("{\"machineId\":").Append(Js(MakineId));
            j.Append(",\"ts\":").Append(Js(DateTime.UtcNow.ToString("o")));
            j.Append(",\"source\":\"syntec-remoteapi\"");
            j.Append(",\"status\":").Append(Js(DurumEsle(d)));

            j.Append(",\"spindleRpm\":").Append(Sayi(Al(d, "ActSpindle")));
            j.Append(",\"feedRate\":").Append(Sayi(Al(d, "ActFeed")));
            j.Append(",\"spindleOverridePct\":").Append(Sayi(Al(d, "OvSpindle")));
            j.Append(",\"feedOverridePct\":").Append(Sayi(Al(d, "OvFeed")));

            j.Append(",\"partCount\":").Append(Sayi(Al(d, "PartCount")));
            // RequiredPart=0 "hedef tanimli degil" demek (gercek tezgahta hep 0 geldi),
            // gecerli bir hedef degil - 0 olarak gosterilmemeli.
            j.Append(",\"partTarget\":").Append(SifirsaNull(Al(d, "RequiredPart")));
            j.Append(",\"partTotal\":").Append(Sayi(Al(d, "TotalPartCount")));

            // CuttingTimePerCycle, O ANKI cevrimde gecen kesme suresi - her saniye
            // artar ve parca bitince sifirlanir (gercek yakalamada 15->26->0 goruldu).
            // Bitmis cevrimin suresi DEGIL, bu yuzden 0 gecerli bir degerdir.
            j.Append(",\"cycleTimeSec\":").Append(Sayi(Al(d, "CycleTimeSec")));
            j.Append(",\"cuttingTimeSec\":").Append(Sayi(Al(d, "AccumCutTime")));
            j.Append(",\"powerOnTimeSec\":").Append(Sayi(Al(d, "PowerOnTime")));
            j.Append(",\"workTimeSec\":").Append(Sayi(Al(d, "WorkTime")));
            j.Append(",\"blockNo\":").Append(Sayi(Al(d, "CurSeq")));

            object prog = Al(d, "CurProg");
            if (prog == null || Convert.ToString(prog).Length == 0) prog = Al(d, "MainProg");
            j.Append(",\"program\":").Append(MetinYaNull(prog));
            j.Append(",\"mainProgram\":").Append(MetinYaNull(Al(d, "MainProg")));
            j.Append(",\"mode\":").Append(MetinYaNull(Al(d, "Mode")));
            j.Append(",\"block\":").Append(MetinYaNull(Al(d, "Block")));

            j.Append(",\"alarms\":").Append(Alarmlar(Al(d, "AlmMsg")));
            // Kontrolcu durus nedeni vermez - operator girisi ya da sure analizinden gelir.
            j.Append(",\"downtimeReason\":null");

            // Normalize edilmeyen ham degerler. rawStatus eslemenin ofisten
            // dogrulanmasini saglar - bu yuzden her mesajda gider.
            j.Append(",\"controller\":{");
            j.Append("\"rawStatus\":").Append(Js(Convert.ToString(Al(d, "Status"))));
            j.Append(",\"rawAlarm\":").Append(Js(Convert.ToString(Al(d, "Alarm"))));
            j.Append(",\"emg\":").Append(Js(Convert.ToString(Al(d, "EMG"))));
            j.Append(",\"isAlarm\":").Append(Js(Convert.ToString(Al(d, "IsAlarm"))));
            j.Append("}");

            j.Append("}");
            return j.ToString();
        }

        // ------------------------------------------------------------- yardimcilar

        public static object Al(Dictionary<string, object> d, string k)
        {
            object v;
            return d.TryGetValue(k, out v) ? v : null;
        }

        public static Exception Kok(Exception ex)
        {
            while (ex.InnerException != null) ex = ex.InnerException;
            return ex;
        }

        /// JSON metin degeri (kacislarla).
        public static string Js(object v)
        {
            if (v == null) return "null";
            string s = Convert.ToString(v);
            var sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else if (c == '\t') sb.Append("\\t");
                else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append("\"").ToString();
        }

        /// Sayisal JSON degeri; okunamadiysa null (0 ile karistirilmamali).
        public static string Sayi(object v)
        {
            if (v == null) return "null";
            try
            {
                double d = Convert.ToDouble(v, CultureInfo.InvariantCulture);
                if (double.IsNaN(d) || double.IsInfinity(d)) return "null";
                return d.ToString("0.####", CultureInfo.InvariantCulture);
            }
            catch { return "null"; }
        }

        static string SifirsaNull(object v)
        {
            if (v == null) return "null";
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture) == 0 ? "null" : Sayi(v); }
            catch { return "null"; }
        }

        static string MetinYaNull(object v)
        {
            if (v == null) return "null";
            string s = Convert.ToString(v);
            return s.Length == 0 ? "null" : Js(s);
        }

        /// AlmMsg dizisini [{code,text}] seklinde JSON'a cevirir.
        public static string Alarmlar(object v)
        {
            var arr = v as Array;
            if (arr == null || arr.Length == 0) return "[]";

            var sb = new StringBuilder("[");
            bool ilk = true;
            foreach (object o in arr)
            {
                string metin = Convert.ToString(o);
                if (string.IsNullOrEmpty(metin)) continue;
                if (!ilk) sb.Append(",");
                ilk = false;

                // "ALM1234 aciklama" bicimini kod + metin olarak ayirmayi dene.
                string kod = "";
                string aciklama = metin.Trim();
                int bosluk = aciklama.IndexOf(' ');
                if (bosluk > 0 && bosluk <= 12)
                {
                    kod = aciklama.Substring(0, bosluk);
                    aciklama = aciklama.Substring(bosluk + 1).Trim();
                }
                sb.Append("{\"code\":").Append(Js(kod)).Append(",\"text\":").Append(Js(aciklama)).Append("}");
            }
            return sb.Append("]").ToString();
        }
    }
}
