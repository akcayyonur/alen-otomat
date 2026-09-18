@echo off
setlocal
rem Syntec DLL'leri 32-bit oldugu icin /platform:x86 zorunlu.
set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe

if not exist "%CSC%" (
  echo HATA: csc.exe bulunamadi - %CSC%
  echo .NET Framework 4.x kurulu olmali ^(Windows'ta genelde hazir gelir^).
  exit /b 1
)

"%CSC%" /nologo /platform:x86 /out:"%~dp0syntec-probe.exe" "%~dp0Program.cs"
if errorlevel 1 exit /b 1
echo Derlendi: %~dp0syntec-probe.exe

if not "%~1"=="" (
  copy /Y "%~dp0syntec-probe.exe" "%~1\" >nul
  if errorlevel 1 ( echo Kopyalanamadi: %~1 & exit /b 1 )
  echo Kopyalandi: %~1
)
