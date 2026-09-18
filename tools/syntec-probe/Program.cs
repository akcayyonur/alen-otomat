// Syntec RemoteAPI yakalama araci.
//
// Kontrolcuye baglanir, veri okuma fonksiyonlarini periyodik cagirir ve
// hangilerinin gercekten calistigini raporlar. Ciktisi hem JSONL kaydi hem de
// "su alan geldi / su alan gelmedi" ozeti - config/machines.json'daki reports
// listesini bununla kesinlestirecegiz.
//
// Metotlar yansimayla cagriliyor: ByRef parametrelerin out mu ref mi oldugu
// metadata'dan ayirt edilemiyor ve surumler arasi imza degisebiliyor; yansima
// ikisinde de calisir.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;

static class Probe
{
    static Type CncType;
    static object Cnc;
    static readonly Dictionary<string, int> Basarili = new Dictionary<string, int>();
    static readonly Dictionary<string, string> SonHata = new Dictionary<string, string>();
    static readonly HashSet<string> BilinmeyenDurum = new HashSet<string>();
    static string IngestUrl;
    static string MakineId;
    static int IngestGonderilen, IngestHata;

    static int Main(string[] argv)
    {
        var arg = Args(argv);
        string host = Get(arg, "host", "127.0.0.1");
        int saniye = int.Parse(Get(arg, "seconds", "60"));
        int aralik = int.Parse(Get(arg, "interval", "1000"));
        string dll = Get(arg, "dll", "Syntec.RemoteCNC.Win32.dll");
        string cikti = Get(arg, "out", "syntec-" + host.Replace('.', '_') + "-" +
                           DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".jsonl");
        IngestUrl = Get(arg, "ingest", null);
        MakineId = Get(arg, "machine-id", "CNC-01");

        Console.WriteLine("[probe] hedef      : " + host);
        Console.WriteLine("[probe] sure       : " + saniye + " sn, " + aralik + " ms aralikla");
        Console.WriteLine("[probe] kayit      : " + cikti);
        if (IngestUrl != null)
            Console.WriteLine("[probe] ingest     : " + IngestUrl + "  (makine " + MakineId + ")");
        Console.WriteLine();

        Assembly asm;
        try
        {
            asm = Assembly.LoadFrom(Path.GetFullPath(dll));
        }
        catch (Exception ex)
        {
            Console.WriteLine("[probe] DLL yuklenemedi: " + ex.Message);
            Console.WriteLine("[probe] Bu programi Bin klasorunden calistir (yanindaki native dll'lere ihtiyac var).");
            return 1;
        }

        CncType = asm.GetType("Syntec.Remote.SyntecRemoteCNC");
        if (CncType == null) { Console.WriteLine("[probe] SyntecRemoteCNC tipi bulunamadi"); return 1; }

        try
        {
            Cnc = Activator.CreateInstance(CncType, new object[] { host });
        }
        catch (Exception ex)
        {
            Console.WriteLine("[probe] nesne olusturulamadi: " + Kok(ex).Message);
            return 1;
        }

        bool bagli = false;
        try { bagli = (bool)CncType.GetMethod("isConnected").Invoke(Cnc, null); }
        catch (Exception ex) { Console.WriteLine("[probe] isConnected hatasi: " + Kok(ex).Message); }

        Console.WriteLine("[probe] baglanti   : " + (bagli ? "VAR" : "YOK"));
        if (!bagli)
        {
            Console.WriteLine();
            Console.WriteLine("Kontrol listesi:");
            Console.WriteLine("  - Kontrolcude Kernel Server calisiyor mu (5566/5568/5570/5572 acik mi)");
            Console.WriteLine("  - PC guvenlik duvarinda 5568 ve 5570 GELEN baglantiya acik mi");
            Console.WriteLine("  - IP dogru mu");
            return 1;
        }

        Console.WriteLine();
        Kimlik();

        Console.WriteLine();
        Console.WriteLine("[probe] veri toplaniyor...");
        using (var yazici = new StreamWriter(cikti, false, new UTF8Encoding(false)))
        {
            var bitis = saniye <= 0 ? DateTime.MaxValue : DateTime.Now.AddSeconds(saniye);
            int ornek = 0;
            while (DateTime.Now < bitis)
            {
                var d = new Dictionary<string, object>();
                var kayit = Ornekle(d);
                yazici.WriteLine(kayit);
                yazici.Flush();
                ornek++;

                if (IngestUrl != null) Gonder(Normalize(d));

                Console.Write("\r[probe] " + ornek + " ornek" +
                    (IngestUrl != null ? "  gonderilen " + IngestGonderilen + ", hata " + IngestHata : "") + "   ");
                Thread.Sleep(aralik);
            }
            Console.WriteLine();
            Console.WriteLine();
            Ozet(ornek);
        }

        try { CncType.GetMethod("Close").Invoke(Cnc, null); } catch { }
        Console.WriteLine();
        Console.WriteLine("Ham kayit: " + Path.GetFullPath(cikti));
        return 0;
    }

    /// Kontrolcu kimligi - bir kez okunur, degismez.
    static void Kimlik()
    {
        Console.WriteLine("=== KONTROLCU ===");
        Ozellik("SeriesNo");
        Ozellik("MainBoardPlatformName");
        Ozellik("CncOption");

        object[] a = { (short)0, null, (short)0, null, null, null };
        if (Cagir("READ_information", a) == 0)
        {
            Console.WriteLine("  Eksen sayisi          : " + a[0]);
            Console.WriteLine("  CncType               : " + a[1]);
            Console.WriteLine("  Azami eksen           : " + a[2]);
            Console.WriteLine("  Seri (M/T)            : " + a[3]);
            Console.WriteLine("  NC surum              : " + a[4]);
            Console.WriteLine("  Eksen adlari          : " + Dizi(a[5]));
        }
    }

    static void Ozellik(string ad)
    {
        try
        {
            var m = CncType.GetMethod("get_" + ad);
            if (m != null) Console.WriteLine("  " + ad.PadRight(22) + ": " + m.Invoke(Cnc, null));
        }
        catch (Exception ex) { Console.WriteLine("  " + ad.PadRight(22) + ": HATA " + Kok(ex).Message); }
    }

    /// Tek bir ornek: tum veri fonksiyonlarini cagirip JSON satiri uretir.
    static string Ornekle(Dictionary<string, object> d)
    {
        var j = new StringBuilder();
        j.Append("{\"ts\":\"").Append(DateTime.Now.ToString("o")).Append("\"");

        object[] st = { null, null, 0, null, null, null, null };
        if (Cagir("READ_status", st) == 0)
        {
            j.Append(",\"status\":{");
            j.Append("\"MainProg\":").Append(Js(st[0]));
            j.Append(",\"CurProg\":").Append(Js(st[1]));
            j.Append(",\"CurSeq\":").Append(Js(st[2]));
            j.Append(",\"Mode\":").Append(Js(st[3]));
            j.Append(",\"Status\":").Append(Js(st[4]));
            j.Append(",\"Alarm\":").Append(Js(st[5]));
            j.Append(",\"EMG\":").Append(Js(st[6]));
            j.Append("}");
            d["MainProg"] = st[0]; d["CurProg"] = st[1]; d["Mode"] = st[3];
            d["Status"] = st[4]; d["Alarm"] = st[5]; d["EMG"] = st[6];
        }

        object[] sp = { 0f, 0f, 0f, 0 };
        if (Cagir("READ_spindle", sp) == 0)
        {
            j.Append(",\"spindle\":{");
            j.Append("\"OvFeed\":").Append(Js(sp[0]));
            j.Append(",\"OvSpindle\":").Append(Js(sp[1]));
            j.Append(",\"ActFeed\":").Append(Js(sp[2]));
            j.Append(",\"ActSpindle\":").Append(Js(sp[3]));
            j.Append("}");
            d["ActFeed"] = sp[2]; d["ActSpindle"] = sp[3];
        }

        object[] pc = { 0, 0, 0 };
        if (Cagir("READ_part_count", pc) == 0)
        {
            j.Append(",\"partCount\":{");
            j.Append("\"part\":").Append(Js(pc[0]));
            j.Append(",\"required\":").Append(Js(pc[1]));
            j.Append(",\"total\":").Append(Js(pc[2]));
            j.Append("}");
            d["PartCount"] = pc[0]; d["TotalPartCount"] = pc[2];
        }

        object[] tm = { 0, 0, 0, 0 };
        if (Cagir("READ_time", tm) == 0)
        {
            j.Append(",\"time\":{");
            j.Append("\"PowerOnTime\":").Append(Js(tm[0]));
            j.Append(",\"AccumulateCuttingTime\":").Append(Js(tm[1]));
            j.Append(",\"CuttingTimePerCycle\":").Append(Js(tm[2]));
            j.Append(",\"WorkTime\":").Append(Js(tm[3]));
            j.Append("}");
            d["CycleTimeSec"] = tm[2];
        }

        object[] al = { false, null, null };
        if (Cagir("READ_alm_current", al) == 0)
        {
            j.Append(",\"alarm\":{\"isAlarm\":").Append(((bool)al[0]) ? "true" : "false");
            j.Append(",\"messages\":").Append(JsDizi(al[1]));
            j.Append("}");
            d["IsAlarm"] = al[0]; d["AlmMsg"] = al[1];
        }

        object[] blk = { null };
        if (Cagir("READ_nc_current_block", blk) == 0)
            j.Append(",\"currentBlock\":").Append(Js(blk[0]));

        j.Append("}");
        return j.ToString();
    }

    /// Metodu yansimayla cagirir; donus kodu 0 ise basarili sayilir.
    static short Cagir(string ad, object[] args)
    {
        try
        {
            var yontemler = CncType.GetMethods().Where(x => x.Name == ad && x.GetParameters().Length == args.Length).ToArray();
            if (yontemler.Length == 0) { SonHata[ad] = "metot yok"; return -1; }

            short rc = (short)yontemler[0].Invoke(Cnc, args);
            if (rc == 0) Basarili[ad] = (Basarili.ContainsKey(ad) ? Basarili[ad] : 0) + 1;
            else SonHata[ad] = "donus kodu " + rc;
            return rc;
        }
        catch (Exception ex)
        {
            SonHata[ad] = Kok(ex).Message;
            return -1;
        }
    }

    static void Ozet(int toplam)
    {
        Console.WriteLine("=== SONUC (" + toplam + " ornek) ===");
        string[] hepsi = { "READ_status", "READ_spindle", "READ_part_count", "READ_time",
                           "READ_alm_current", "READ_nc_current_block" };
        foreach (var f in hepsi)
        {
            int ok = Basarili.ContainsKey(f) ? Basarili[f] : 0;
            string durum = ok == toplam ? "CALISTI" : ok > 0 ? "KISMEN (" + ok + "/" + toplam + ")" : "CALISMADI";
            string ek = ok < toplam && SonHata.ContainsKey(f) ? "  - " + SonHata[f] : "";
            Console.WriteLine("  " + f.PadRight(24) + durum + ek);
        }

        if (BilinmeyenDurum.Count > 0)
        {
            Console.WriteLine();
            Console.WriteLine("  DIKKAT - taninmayan Status degeri (IDLE olarak gonderildi):");
            foreach (var x in BilinmeyenDurum) Console.WriteLine("    " + x);
            Console.WriteLine("  Bunlari bildir - durum eslemesi buna gore duzeltilecek.");
        }

        if (IngestUrl != null)
        {
            Console.WriteLine();
            Console.WriteLine("  ingest: " + IngestGonderilen + " gonderildi, " + IngestHata + " hata");
        }
    }


    /// Syntec'in Status/Alarm/EMG metinlerini semadaki enum'a cevirir.
    /// Taninmayan deger sessizce eslenmez - kaydedilir ve ozette raporlanir.
    static string DurumEsle(Dictionary<string, object> d)
    {
        string s = Convert.ToString(Al(d, "Status")).Trim().ToUpperInvariant();
        string a = Convert.ToString(Al(d, "Alarm")).Trim().ToUpperInvariant();
        string e = Convert.ToString(Al(d, "EMG")).Trim().ToUpperInvariant();

        if (e == "EMG" || a == "ALARM") return "ALARM";

        if (s.Contains("RUN") || s.Contains("START") || s.Contains("BUSY") || s.Contains("CYCLE"))
            return "RUNNING";
        if (s.Contains("READY") || s.Contains("STOP") || s.Contains("PAUSE") ||
            s.Contains("HOLD") || s.Contains("IDLE") || s.Contains("RESET"))
            return "IDLE";

        if (s.Length > 0) BilinmeyenDurum.Add(s);
        return "IDLE";
    }

    /// shared/schema.js'teki sozlesmeye cevirir.
    static string Normalize(Dictionary<string, object> d)
    {
        var j = new StringBuilder();
        j.Append("{\"machineId\":").Append(Js(MakineId));
        j.Append(",\"ts\":").Append(Js(DateTime.UtcNow.ToString("o")));
        j.Append(",\"source\":\"syntec-remoteapi\"");
        j.Append(",\"status\":").Append(Js(DurumEsle(d)));

        j.Append(",\"spindleRpm\":").Append(Js(Al(d, "ActSpindle")));
        j.Append(",\"feedRate\":").Append(Js(Al(d, "ActFeed")));
        j.Append(",\"partCount\":").Append(Js(Al(d, "PartCount")));

        // 0 cevrim suresi "henuz parca bitmedi" demek - veri yoklugu olarak gonderilir.
        object cyc = Al(d, "CycleTimeSec");
        j.Append(",\"cycleTimeSec\":").Append(cyc == null || Convert.ToInt32(cyc) == 0 ? "null" : Js(cyc));

        object prog = Al(d, "CurProg");
        if (prog == null || Convert.ToString(prog).Length == 0) prog = Al(d, "MainProg");
        j.Append(",\"program\":").Append(prog == null || Convert.ToString(prog).Length == 0 ? "null" : Js(prog));

        j.Append(",\"alarms\":").Append(Alarmlar(Al(d, "AlmMsg")));
        j.Append(",\"downtimeReason\":null");
        j.Append("}");
        return j.ToString();
    }

    /// Alarm mesaj formati: ("motion" "number" "descriptions")
    static string Alarmlar(object msg)
    {
        var arr = msg as Array;
        if (arr == null || arr.Length == 0) return "[]";
        var p = new List<string>();
        foreach (var x in arr)
        {
            string m = Convert.ToString(x);
            if (string.IsNullOrEmpty(m)) continue;
            var parca = m.Split(new[] { ' ' }, 2, StringSplitOptions.RemoveEmptyEntries);
            string kod = parca.Length > 0 ? parca[0] : "";
            p.Add("{\"code\":" + Js(kod) + ",\"text\":" + Js(m) + "}");
        }
        return "[" + string.Join(",", p.ToArray()) + "]";
    }

    static void Gonder(string govde)
    {
        try
        {
            var req = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(IngestUrl);
            req.Method = "POST";
            req.ContentType = "application/json; charset=utf-8";
            req.Timeout = 5000;
            req.Proxy = null;
            var bayt = Encoding.UTF8.GetBytes(govde);
            req.ContentLength = bayt.Length;
            using (var st = req.GetRequestStream()) st.Write(bayt, 0, bayt.Length);
            using (var res = (System.Net.HttpWebResponse)req.GetResponse())
            {
                if ((int)res.StatusCode >= 200 && (int)res.StatusCode < 300) IngestGonderilen++;
                else IngestHata++;
            }
        }
        catch { IngestHata++; }
    }

    static object Al(Dictionary<string, object> d, string k)
    {
        return d.ContainsKey(k) ? d[k] : null;
    }

    static Exception Kok(Exception ex) { return ex.InnerException ?? ex; }

    static string Js(object v)
    {
        if (v == null) return "null";
        if (v is string) return "\"" + ((string)v).Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        if (v is float) return ((float)v).ToString("R", CultureInfo.InvariantCulture);
        if (v is double) return ((double)v).ToString("R", CultureInfo.InvariantCulture);
        return Convert.ToString(v, CultureInfo.InvariantCulture);
    }

    static string JsDizi(object v)
    {
        var arr = v as Array;
        if (arr == null) return "[]";
        var p = new List<string>();
        foreach (var x in arr) p.Add(Js(Convert.ToString(x)));
        return "[" + string.Join(",", p.ToArray()) + "]";
    }

    static string Dizi(object v)
    {
        var arr = v as Array;
        if (arr == null) return "-";
        var p = new List<string>();
        foreach (var x in arr) p.Add(Convert.ToString(x));
        return string.Join(", ", p.ToArray());
    }

    static Dictionary<string, string> Args(string[] argv)
    {
        var d = new Dictionary<string, string>();
        for (int i = 0; i < argv.Length; i++)
            if (argv[i].StartsWith("--") && i + 1 < argv.Length && !argv[i + 1].StartsWith("--"))
                d[argv[i].Substring(2)] = argv[++i];
        return d;
    }

    static string Get(Dictionary<string, string> d, string k, string v)
    {
        return d.ContainsKey(k) ? d[k] : v;
    }
}
