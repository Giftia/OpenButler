"""Read-only mocked process checks and installed builder lifecycle contracts."""
import os,pathlib,subprocess,tempfile,unittest
desktop=pathlib.Path(__file__).resolve().parents[1]
guard=desktop/'installer/check-windows-trial-stopped.ps1'
class TrialInstallerTests(unittest.TestCase):
    def check(self,expression,expected,existing=False,lifecycle='Install',product='Trial'):
        script="function Test-Path { param($LiteralPath) return $"+str(existing).lower()+" }\nfunction Get-CimInstance { param($Filter) "+expression+" }\n& '"+str(guard).replace("'","''")+"' -Lifecycle "+lifecycle+" -Product "+product+"\nexit $LASTEXITCODE\n"
        with tempfile.TemporaryDirectory() as temporary:
            wrapper=pathlib.Path(temporary)/'mock.ps1';wrapper.write_text(script,encoding='utf-8')
            result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-File',str(wrapper)],capture_output=True,timeout=10)
            self.assertEqual(result.returncode,expected)
    def test_stopped(self):self.check('return @()',0)
    def test_running_trial(self):self.check("return [pscustomobject]@{Name='OpenButler Preview Windows Trial.exe';ExecutablePath=(Join-Path $env:LOCALAPPDATA 'Programs\\OpenButlerWindowsTrial\\OpenButler Preview Windows Trial.exe')}",20)
    def test_running_backend(self):self.check("return [pscustomobject]@{Name='openbutler-backend-windows-trial.exe';ExecutablePath=(Join-Path $env:LOCALAPPDATA 'Programs\\OpenButlerWindowsTrial\\resources\\backend\\openbutler-backend-windows-trial.exe')}",20)
    def test_missing_path(self):self.check("return [pscustomobject]@{Name='openbutler-backend-windows-trial.exe';ExecutablePath=$null}",21)
    def test_same_name_other_install(self):self.check("return [pscustomobject]@{Name='OpenButler Preview Windows Trial.exe';ExecutablePath=(Join-Path $env:LOCALAPPDATA 'Programs\\OpenButler\\OpenButler Preview Windows Trial.exe')}",0)
    def test_query_failure(self):self.check("throw 'query unavailable'",21)
    def test_existing_uninstaller_blocks_upgrade(self):self.check('return @()',22,existing=True)
    def test_new_uninstall_checks_without_dispatching_old(self):self.check('return @()',0,existing=True,lifecycle='Uninstall')
    def test_unexpected_identity(self):self.check("return [pscustomobject]@{Name='unexpected.exe';ExecutablePath='C:\\unexpected.exe'}",21)
    def test_rc_stopped(self):self.check('return @()',0,product='RC')
    def test_rc_running(self):self.check("return [pscustomobject]@{Name='OpenButler Preview Windows RC.exe';ExecutablePath=(Join-Path $env:LOCALAPPDATA 'Programs\\OpenButlerWindowsRC\\OpenButler Preview Windows RC.exe')}",20,product='RC')
    def test_rc_unknown_path(self):self.check("return [pscustomobject]@{Name='openbutler-backend-windows-rc.exe';ExecutablePath=$null}",21,product='RC')
    def test_rc_existing_uninstaller(self):self.check('return @()',22,existing=True,product='RC')
    def test_rc_portable_data_home_unknown(self):self.check("return [pscustomobject]@{Name='OpenButler Preview Windows RC.exe';ExecutablePath='C:\\portable\\OpenButler Preview Windows RC.exe'}",21,product='RC')
    def test_rc_namespace(self):
        include=(desktop/'installer/installer-windows-rc.nsh').read_text()
        self.assertIn('OpenButlerWindowsRC',include)
        self.assertIn('-Product RC',include)
        self.assertIn('587ee0ff-3095-561a-8f24-33cf8527f167',include)
        self.assertNotIn('OpenButlerWindowsTrial',include)
    def test_both_builder_lifecycle_paths(self):
        include=(desktop/'installer/installer-windows-trial.nsh').read_text()
        templates=desktop/'node_modules/app-builder-lib/templates/nsis'
        self.assertIn('!macro customCheckAppRunning',include)
        uninit=include.split('!macro customUnInit\n',1)[1].split('!macroend',1)[0]
        self.assertLess(uninit.index('!insertmacro openbutlerRequireCurrentUser'),uninit.index('!insertmacro customCheckAppRunning'))
        for file in ['installSection.nsh','uninstaller.nsh']:
            self.assertIn('!insertmacro CHECK_APP_RUNNING',(templates/file).read_text())
        install=(templates/'installSection.nsh').read_text()
        self.assertLess(install.index('!insertmacro CHECK_APP_RUNNING'),install.index('!insertmacro uninstallOldVersion'))
        self.assertLess(install.index('!insertmacro CHECK_APP_RUNNING'),install.index('!insertmacro installApplicationFiles'))
        init=(templates/'installer.nsi').read_text().split('Function .onInit',1)[1].split('FunctionEnd',1)[0]
        self.assertLess(init.index('!insertmacro initMultiUser'),init.index('!insertmacro customInit'))
        mode=(templates/'multiUserUi.nsh').read_text()
        self.assertLess(mode.index('${UAC_IsInnerInstance}'),mode.index('!insertmacro customInstallMode'))
        self.assertLess(mode.index('${isForAllUsers}'),mode.index('${if} $isForceCurrentInstall == "1"'))
        uninit=(templates/'uninstaller.nsh').read_text().split('Function un.onInit',1)[1].split('FunctionEnd',1)[0]
        self.assertLess(uninit.index('call un.checkAppRunning'),uninit.index('!insertmacro initMultiUser'))
        self.assertLess(uninit.index('!insertmacro initMultiUser'),uninit.index('!insertmacro customUnInit'))
        self.assertIn('!ifmacrodef customCheckAppRunning',(templates/'include/allowOnlyOneInstallerInstance.nsh').read_text())
        self.assertIn('!insertmacro customUnInit',(templates/'uninstaller.nsh').read_text())
        self.assertNotIn('taskkill',include.lower());self.assertNotIn('stop-process',guard.read_text().lower())
        self.assertIn('/TIMEOUT=15000',include)
        self.assertIn('SetErrorLevel 87',include)
if __name__=='__main__':unittest.main(verbosity=2)
