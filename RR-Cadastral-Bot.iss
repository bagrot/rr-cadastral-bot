#define MyAppName "Кадастробот"
#define MyAppVersion "3.0.5"
#define MyAppPublisher "Кадастробот"
#define MyAppExeName "RR-Cadastral-Bot.exe"

[Setup]
AppId={{17BD74B5-56BA-430A-B826-6C8E5AA943A5}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Кадастробот
DefaultGroupName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
OutputDir=dist
OutputBaseFilename=RR-Cadastral-Bot-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
SetupLogging=yes

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Дополнительно:"; Flags: unchecked

[Files]
Source: "RR-Cadastral-Bot-3.0.5.exe"; DestDir: "{app}"; DestName: "RR-Cadastral-Bot.exe"; Flags: ignoreversion
Source: "start.js"; DestDir: "{app}"; Flags: ignoreversion
; Пользователь меняет ссылки через приложение. При обновлении этот файл сохраняется.
Source: "config.js"; DestDir: "{app}"; Flags: onlyifdoesntexist
Source: "package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "package-lock.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "QUICK_START.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "UPDATE_RELEASE_GUIDE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "node_modules\*"; DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[InstallDelete]
Type: files; Name: "{app}\launcher-background.jfif"
Type: files; Name: "{app}\launcher-background-v2.png"
Type: files; Name: "{app}\launcher-background-v3.png"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Запустить {#MyAppName}"; Flags: nowait postinstall skipifsilent
