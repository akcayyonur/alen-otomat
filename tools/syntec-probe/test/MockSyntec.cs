// Test icin sahte Syntec.RemoteCNC. Gercek DLL'in imzalarini birebir taklit eder
// (yansima ciktisindan alindi) ve calisan bir tezgahi simule eder.
using System;

namespace Syntec.Remote
{
    public class SyntecRemoteCNC
    {
        readonly string host;
        int tik;

        public SyntecRemoteCNC(string ip) { host = ip; }
        public SyntecRemoteCNC(string ip, int port) { host = ip; }

        public string SeriesNo { get { return "M9L4379"; } }
        public string CncOption { get { return "4 5"; } }
        public string MainBoardPlatformName { get { return "AM335x-H"; } }
        public string Host { get { return host; } }

        public bool isConnected() { return true; }
        public void Close() { }

        public short READ_information(out short axes, out string cncType, out short maxAxes,
                                      out string series, out string ncVer, out string[] axisName)
        {
            axes = 4; cncType = "11B"; maxAxes = 10; series = "Lathe"; ncVer = "10.116.54S";
            axisName = new[] { "X", "Y", "Z", "C" };
            return 0;
        }

        public short READ_status(out string mainProg, out string curProg, out int curSeq,
                                 out string mode, out string status, out string alarm, out string emg)
        {
            tik++;
            mainProg = "BERG\\140100187";
            curProg = "BERG\\140100187";
            curSeq = 12;
            mode = "AUTO";
            // Once RUN, sonra alarm, sonra taninmayan bir deger - ucunu de test edelim.
            if (tik <= 3) { status = "RUN"; alarm = "****"; emg = "****"; }
            else if (tik == 4) { status = "RUN"; alarm = "ALARM"; emg = "****"; }
            else { status = "WHATEVER"; alarm = "****"; emg = "****"; }
            return 0;
        }

        public short READ_spindle(out float ovFeed, out float ovSpindle, out float actFeed, out int actSpindle)
        {
            ovFeed = 100f; ovSpindle = 100f;
            actFeed = 8469.6f; actSpindle = 1977;
            return 0;
        }

        public short READ_part_count(out int part, out int required, out int total)
        {
            part = 962; required = 0; total = 11064;
            return 0;
        }

        public short READ_time(out int powerOn, out int accumCut, out int cyclePerCut, out int work)
        {
            powerOn = 1742600 + tik; accumCut = 1743459; cyclePerCut = tik <= 2 ? 0 : 182; work = 15;
            return 0;
        }

        public short READ_alm_current(out bool isAlarm, out string[] msg, out DateTime[] time)
        {
            if (tik == 4)
            {
                isAlarm = true;
                msg = new[] { "MOT-1023 Spindle overload" };
                time = new[] { DateTime.Now };
            }
            else { isAlarm = false; msg = new string[0]; time = new DateTime[0]; }
            return 0;
        }

        public short READ_nc_current_block(out string block)
        {
            block = null;
            return -18; // gercek kontrolcude de desteklenmiyordu
        }
    }
}
