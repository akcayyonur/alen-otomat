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

    static int Main(string[] argv)
    {
        var arg = Args(argv);
        string host = Get(arg, "host", "127.0.0.1");
        int saniye = int.Parse(Get(arg, "seconds", "60"));
        int aralik = int.Parse(Get(arg, "interval", "1000"));
        string dll = Get(arg, "dll", "Syntec.RemoteCNC.Win32.dll");
        string cikti = Get(arg, "out", "syntec-" + host.Replace('.', '_') + "-" +
                           DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".jsonl");

        Console.WriteLine("[probe] hedef      : " + host);
        Console.WriteLine("[probe] sure       : " + saniye + " sn, " + aralik + " ms aralikla");
        Console.WriteLine("[probe] kayit      : " + cikti);
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
            var bitis = DateTime.Now.AddSeconds(saniye);
            int ornek = 0;
            while (DateTime.Now < bitis)
            {
                var kayit = Ornekle();
                yazici.WriteLine(kayit);
                yazici.Flush();
                ornek++;
                Console.Write("\r[probe] " + ornek + " ornek   ");
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
    static string Ornekle()
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
        }

        object[] pc = { 0, 0, 0 };
        if (Cagir("READ_part_count", pc) == 0)
        {
            j.Append(",\"partCount\":{");
            j.Append("\"part\":").Append(Js(pc[0]));
            j.Append(",\"required\":").Append(Js(pc[1]));
            j.Append(",\"total\":").Append(Js(pc[2]));
            j.Append("}");
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
        }

        object[] al = { false, null, null };
        if (Cagir("READ_alm_current", al) == 0)
        {
            j.Append(",\"alarm\":{\"isAlarm\":").Append(((bool)al[0]) ? "true" : "false");
            j.Append(",\"messages\":").Append(JsDizi(al[1]));
            j.Append("}");
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
