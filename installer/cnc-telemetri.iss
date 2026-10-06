; CNC Telemetri - kurulum paketi (Inno Setup 6)
;
; Bu betik tek basina derlenmez: yuklenecek dosyalar installer\payload\ altinda
; hazir olmali. Onu build-installer.ps1 hazirlar ve ISCC'yi cagirir.
;
; Kurulum yerlesimi:
;   C:\CNC-Telemetri\
;     runtime\node.exe        gomulu Node (makinede Node kurulu olmasi gerekmez)
;     backend\ shared\ dashboard\ config\   proje kodu
;     agent\                  syntec-agent.exe + Syntec DLL'leri (BIRLIKTE - bolunmez)
;     kurulum\kurulum.ps1     gorev + guvenlik duvari kaydi (yukleme sonrasi cagrilir)
;     data\ logs\             calisirken olusur; kaldirmada SILINMEZ

#ifndef Surum
  #define Surum "0.0.0"
#endif
#ifndef Payload
  #define Payload "payload"
#endif

#define Uygulama "CNC Telemetri"
#define Port "3000"

[Setup]
AppId={{2EF1E2C3-2481-4FF9-B911-36E6A83796F1}
AppName={#Uygulama}
AppVersion={#Surum}
AppPublisher=alen-otomat
; Bosluksuz, kisa yol: gorevler ve loglar tirnak sorunu yasamasin.
DefaultDirName={sd}\CNC-Telemetri
DefaultGroupName={#Uygulama}
DisableProgramGroupPage=yes
OutputDir=output
OutputBaseFilename=CNC-Telemetri-Kurulum-{#Surum}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Guvenlik duvari ve zamanlanmis gorev icin yonetici sart.
PrivilegesRequired=admin
; Gomulu node.exe x64. 64-bit modda calismak {sys}'i gercek System32 yapar
; (32-bit PowerShell'e dusmeyelim).
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#Uygulama}
; Calisan surecleri kendimiz (yola gore) durduruyoruz, Inno'nun degil.
CloseApplications=no
RestartApplications=no
InfoAfterFile=kurulum-sonrasi.txt

[Languages]
Name: "tr"; MessagesFile: "compiler:Languages\Turkish.isl"

[Tasks]
Name: "agaac"; Description: "Dashboard'a ağdaki diğer bilgisayarlardan erişime izin ver (güvenlik duvarında {#Port} portunu açar). Giriş şifresi yok: yalnızca güvenilir ofis ağında kullanın."; GroupDescription: "Ağ erişimi:"
Name: "masaustu"; Description: "Masaüstüne CNC Telemetri uygulamasını koy (açınca hizmetleri başlatır ve dashboard'u açar)"; GroupDescription: "Kısayollar:"

[Dirs]
Name: "{app}\data"
Name: "{app}\logs"

[Files]
Source: "{#Payload}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Payload}\backend\*"; DestDir: "{app}\backend"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Payload}\shared\*"; DestDir: "{app}\shared"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Payload}\dashboard\*"; DestDir: "{app}\dashboard"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Payload}\kurulum\*"; DestDir: "{app}\kurulum"; Flags: ignoreversion recursesubdirs createallsubdirs
; Ajan + Syntec DLL'leri: klasor bolunmez, hepsi birlikte (ajan DLL'lerin yanindan calisir).
Source: "{#Payload}\agent\*"; DestDir: "{app}\agent"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Payload}\package.json"; DestDir: "{app}"; Flags: ignoreversion
; Masaustu uygulamasi: acinca backend + ajani ayaga kaldirir, dashboard'u acar.
Source: "{#Payload}\CNC Telemetri.exe"; DestDir: "{app}"; Flags: ignoreversion
; Onkosul: Visual C++ 2005 SP1 (x86) calisma zamani (Microsoft imzali, degistirilmemis).
; Syntec'in native DLL'leri buna bagimli. Gecici klasore acilir, eksikse kurulur, silinir.
Source: "{#Payload}\prereq\vcredist_x86.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall
; Surucu kaydi kod tarafindan yonetilir - her surumde guncellenir.
Source: "{#Payload}\config\drivers.json"; DestDir: "{app}\config"; Flags: ignoreversion
; Tezgah listesi ise KULLANICININ: ayarlar ekrani buraya yazar. Guncelleme ve
; kaldirma bunu ezmesin / silmesin.
Source: "{#Payload}\config\machines.json"; DestDir: "{app}\config"; Flags: onlyifdoesntexist uninsneveruninstall

[Icons]
Name: "{group}\{#Uygulama}"; Filename: "{app}\CNC Telemetri.exe"; WorkingDir: "{app}"
Name: "{group}\Log klasörü"; Filename: "{app}\logs"
Name: "{group}\{#Uygulama} kaldır"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#Uygulama}"; Filename: "{app}\CNC Telemetri.exe"; WorkingDir: "{app}"; Tasks: masaustu

[Run]
; Yukleyici yonetici, ama "postinstall" girdisi asil kullanici olarak calisir:
; uygulama normal yetkiyle acilir, hizmetler ayaktaysa dogrudan dashboard'u acar.
Filename: "{app}\CNC Telemetri.exe"; Description: "CNC Telemetri'yi aç (dashboard'u tarayıcıda göster)"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\kurulum\kurulum.ps1"" -Kaldir"; Flags: runhidden waituntilterminated; RunOnceId: "KurulumKaldir"

[Code]
function PowerShellYolu(): String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

{ kurulum.ps1'i verilen ek argumanlarla gizli pencerede calistirir. }
function BetigiCalistir(const Ek: String; var Kod: Integer): Boolean;
var
  Betik: String;
begin
  Betik := ExpandConstant('{app}\kurulum\kurulum.ps1');
  Result := Exec(PowerShellYolu(),
    '-NoProfile -ExecutionPolicy Bypass -File "' + Betik + '" ' + Ek,
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Kod);
end;

{ Syntec'in native DLL'leri (OCApi.dll, OCUser.dll, OCKrnl.dll) Visual C++ 2005 SP1
  (x86) calisma zamanina bagimli. Bilgisayarda yoksa DLL yuklenmez (hata 0x800736B1) ve
  ajan tornaya baglanamaz; sahada fabrika PC'sinde yasandi.
  Kurulu mu: bu calisma zamaninin MFC bileseni WinSxS\Fusion altinda x86_microsoft.vc80.mfc_*
  klasoru olarak durur. Windows kendisi MFC 2005 ile gelmez, yani bu klasor varsa paket
  kuruludur. Yanlis "yok" sonucu zararsiz: paket yeniden kurulur. }
function VcCalismaZamaniVarMi(): Boolean;
var
  Bul: TFindRec;
begin
  Result := FindFirst(ExpandConstant('{win}\WinSxS\Fusion\x86_microsoft.vc80.mfc_*'), Bul);
  if Result then FindClose(Bul);
end;

{ Eski kurulum calisiyorsa node.exe ve ajan dosyalari kilitlidir; uzerine
  yazmadan once durdur. Ilk kurulumda betik yoktur, atlanir. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Kod: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\kurulum\kurulum.ps1')) then
    BetigiCalistir('-Durdur', Kod);
end;

{ Dosyalar yerlestikten sonra: guvenlik duvari + acilista baslayan gorevler. }
procedure CurStepChanged(CurStep: TSetupStep);
var
  Kod: Integer;
  Ek: String;
begin
  if CurStep = ssPostInstall then
  begin
    { Hizmetleri baslatmadan ONCE: ajan acilir acilmaz Syntec DLL'lerini yukler. }
    if not VcCalismaZamaniVarMi() then
    begin
      WizardForm.StatusLabel.Caption := 'Visual C++ 2005 çalışma zamanı kuruluyor...';
      WizardForm.FileNameLabel.Caption := '';
      { 0 tamam, 3010 tamam (yeniden baslatma onerir), 1638 daha yeni/ayni surum kurulu. }
      if (not Exec(ExpandConstant('{tmp}\vcredist_x86.exe'), '/q', '', SW_HIDE, ewWaitUntilTerminated, Kod))
         or ((Kod <> 0) and (Kod <> 3010) and (Kod <> 1638)) then
        MsgBox('Visual C++ 2005 SP1 (x86) çalışma zamanı kurulamadı (kod ' + IntToStr(Kod) + ').' + #13#10 + #13#10 +
          'Syntec DLL''leri bu bileşen olmadan yüklenemez, tezgahlardan veri gelmez.' + #13#10 +
          'Elle kurun: vcredist_x86.exe (Microsoft İndirme Merkezi, id 26347).',
          mbError, MB_OK);
    end;

    WizardForm.StatusLabel.Caption := 'Hizmetler kuruluyor ve başlatılıyor...';
    WizardForm.FileNameLabel.Caption := '';

    Ek := '';
    if WizardIsTaskSelected('agaac') then Ek := '-AgaAc';

    if (not BetigiCalistir(Ek, Kod)) or (Kod <> 0) then
      MsgBox('Dosyalar kuruldu ancak hizmetler başlatılamadı (kod ' + IntToStr(Kod) + ').' + #13#10 + #13#10 +
        'Ayrıntı için günlüğe bakın:' + #13#10 +
        ExpandConstant('{app}\logs\kurulum.log') + #13#10 + #13#10 +
        'Sorun giderilince, YÖNETİCİ PowerShell''de şunu çalıştırarak tekrar deneyebilirsiniz:' + #13#10 +
        ExpandConstant('{app}\kurulum\kurulum.ps1'),
        mbError, MB_OK);
  end;
end;
