@echo off
REM Syntec Edge Agent derleme.
REM
REM /platform:x86 ZORUNLU - Syntec dll'leri native 32-bit. 64-bit derlenirse
REM calisma aninda "BadImageFormatException" alinir.
REM
REM Kullanim:
REM   build.bat                     -> syntec-agent.exe uretir
REM   build.bat "C:\...\OpenCNC\Bin" -> uretir ve o klasore kopyalar
REM
REM Ajan, Syntec dll'lerinin bulundugu klasorden calistirilmalidir:
REM   Syntec.OpenCNC.dll  Syntec.RemoteCNC.dll  Syntec.RemoteObj.dll
REM   OCAPI.dll           OCUSER.dll

setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe

if not exist "%CSC%" (
  echo HATA: csc.exe bulunamadi: %CSC%
  echo .NET Framework 4.0 kurulu olmali.
  exit /b 1
)

echo [build] derleniyor...
"%CSC%" /nologo /target:exe /platform:x86 /optimize+ ^
        /out:syntec-agent.exe Agent.cs SyntecReader.cs
if errorlevel 1 (
  echo [build] derleme BASARISIZ
  exit /b 1
)
echo [build] syntec-agent.exe hazir

if "%~1"=="" goto son
if not exist "%~1" (
  echo [build] hedef klasor yok: %~1
  exit /b 1
)
copy /Y syntec-agent.exe "%~1" >nul
if exist machines.txt copy /Y machines.txt "%~1" >nul
echo [build] kopyalandi: %~1
echo [build] oradan calistir:  syntec-agent.exe --ingest http://OFIS-PC:3000/api/ingest

:son
endlocal
