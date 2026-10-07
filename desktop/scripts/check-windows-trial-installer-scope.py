"""Pure source/synthetic checks; never compile or execute an installer.

The modeled hook order is app-builder-lib 24.13.3: .onInit -> mode page ->
install section; silent uninstall checks before initMultiUser/customUnInit.
The existing Windows-only check-windows-trial-installer.py checks the real
PowerShell guard and the installed builder templates independently.
"""
import itertools
import pathlib
import re
import unittest

DESKTOP = pathlib.Path(__file__).resolve().parents[1]


def macro(source, name):
    match = re.search(r'^!macro ' + name + r'\s*\n(.*?)^!macroend', source, re.M | re.S)
    if not match:
        raise AssertionError(f'Missing NSIS macro: {name}')
    return match[1]


class GuardSource:
    """Interpret only this include's guard instructions, with mocked OS reads.

    Unknown instructions fail the test rather than silently granting access.
    This is source regression coverage, not a substitute for compiled listings.
    """
    def __init__(self, product, **overrides):
        self.source = (DESKTOP / f'installer/installer-windows-{product.lower()}.nsh').read_text()
        self.root = rf'C:\Users\test\AppData\Local\Programs\OpenButlerWindows{product}'
        self.values = {'$LOCALAPPDATA': r'C:\Users\test\AppData\Local',
                       '$INSTDIR': self.root, '$installMode': 'CurrentUser',
                       'inner': False, 'allusers': False, 'uninstall': False,
                       'InstallLocation': '', 'UninstallString': '', 'guard_result': '0'}
        self.values.update(overrides)
        self.error = None
        self.stopped_checks = 0

    def value(self, token):
        if token.startswith(('"', "'")):
            token = token[1:-1]
        token = token.replace('$\\"', '"')
        return re.sub(r'\$[A-Za-z0-9_]+', lambda match: str(self.values.get(match[0], '')), token)

    def run(self, name):
        # Expand our includes, not electron-builder or any native instruction.
        body = macro(self.source, name)
        while '!insertmacro ' in body:
            body = re.sub(r'!insertmacro (\w+)', lambda match: macro(self.source, match[1]), body)
        lines = [line.strip() for line in body.splitlines() if line.strip() and not line.lstrip().startswith(';')]
        selected, active = [], True
        for line in lines:
            if line == '!ifdef BUILD_UNINSTALLER':
                active = self.values['uninstall']
            elif line == '!ifndef BUILD_UNINSTALLER':
                active = not self.values['uninstall']
            elif line == '!else':
                active = not active
            elif line == '!endif':
                active = True
            elif active:
                selected.append(line)
        lines = selected
        labels = {line[:-1]: i for i, line in enumerate(lines) if line.endswith(':')}
        i = 0
        while i < len(lines):
            line = lines[i]
            if line.startswith('${If}'):
                conditions = [line[len('${If}'):].strip()]
                while lines[i + 1].startswith('${OrIf}'):
                    i += 1
                    conditions.append(lines[i][len('${OrIf}'):].strip())
                predicates = {'${UAC_IsInnerInstance}': self.values['inner'],
                              '${isForAllUsers}': self.values['allusers'],
                              '$installMode != "CurrentUser"': self.values['$installMode'] != 'CurrentUser'}
                if not any(predicates[condition] for condition in conditions):
                    while lines[i] != '${EndIf}':
                        i += 1
            elif line.startswith('StrCmp '):
                tokens = re.findall(r'''"[^"]*"|'[^']*'|\S+''', line)[1:]
                left, right, target = tokens
                if self.value(left).lower() == self.value(right).lower():
                    i = i + int(target) if target.startswith('+') else labels[target]
                    continue
            elif line.startswith('StrCpy '):
                _, variable, value = line.split(maxsplit=2)
                self.values[variable] = self.value(value)
            elif line.startswith('ReadRegStr '):
                self.values['$0'] = self.values[line.rsplit(' ', 1)[1]]
            elif line.startswith('SetErrorLevel '):
                self.error = int(line.split()[1])
            elif line == 'Quit':
                return False
            elif line.startswith('nsExec::ExecToStack '):
                self.stopped_checks += 1
            elif line == 'Pop $0':
                self.values['$0'] = self.values['guard_result']
            elif line in ('${EndIf}', 'InitPluginsDir', 'Pop $1') or line.endswith(':'):
                pass
            elif line.startswith('File /oname=$PLUGINSDIR\\check-windows-trial-stopped.ps1 '):
                pass  # Never materialize or execute the helper.
            else:
                raise AssertionError(f'Unmodeled guard instruction: {line}')
            i += 1
        return True


class TrialInstallerScopeTests(unittest.TestCase):
    def products(self):
        return ('Trial', 'RC')

    def test_both_initializers_refuse_inner_allusers_and_unknown_mode(self):
        for product, hook, inner, allusers, mode in itertools.product(
                self.products(), ('customInit', 'customUnInit'), (False, True),
                (False, True), ('CurrentUser', 'all', '', 'unknown')):
            with self.subTest(product=product, hook=hook, inner=inner, allusers=allusers, mode=mode):
                guard = GuardSource(product, inner=inner, allusers=allusers, **{'$installMode': mode})
                allowed = guard.run(hook)
                self.assertEqual(allowed, not inner and not allusers and mode == 'CurrentUser')
                if not allowed:
                    self.assertEqual(guard.error, 87)
                    self.assertEqual(guard.stopped_checks, 0)

    def test_normal_and_already_admin_ui_cannot_select_allusers(self):
        for product, already_admin in itertools.product(self.products(), (False, True)):
            with self.subTest(product=product, already_admin=already_admin):
                guard = GuardSource(product)
                self.assertTrue(guard.run('customInit'))
                guard.values.update({'$isForceMachineInstall': '0', '$isForceCurrentInstall': '0'})
                self.assertTrue(guard.run('customInstallMode'))
                # The pinned mode-page PRE honors these before showing radio buttons.
                self.assertEqual(guard.values['$isForceCurrentInstall'], '1')
                self.assertEqual(guard.values['$isForceMachineInstall'], '0')
                self.assertTrue(guard.run('customCheckAppRunning'))
                self.assertEqual(guard.stopped_checks, 1)

    def test_explicit_and_conflicting_allusers_flags_refuse_before_mutation(self):
        for product, mode in itertools.product(self.products(), ('all', 'CurrentUser')):
            # initMultiUser processes /currentuser last; both flags can yield CurrentUser.
            guard = GuardSource(product, allusers=True, **{'$installMode': mode})
            self.assertFalse(guard.run('customInit'))
            self.assertEqual(guard.stopped_checks, 0)

    def test_directory_override_and_malformed_cached_paths_refuse(self):
        for product, field in itertools.product(self.products(), ('$INSTDIR', 'InstallLocation', 'UninstallString')):
            with self.subTest(product=product, field=field):
                guard = GuardSource(product, **{field: r'C:\Program Files\unapproved'})
                self.assertFalse(guard.run('customInit'))
                self.assertEqual(guard.error, 87)

    def test_expected_cached_current_user_paths_allow(self):
        for product in self.products():
            guard = GuardSource(product)
            guard.values['InstallLocation'] = guard.root
            guard.values['UninstallString'] = f'"{guard.root}\\Uninstall OpenButler Preview Windows {product}.exe" /currentuser'
            self.assertTrue(guard.run('customInit'))

    def test_final_directory_and_stopped_guard_fail_closed(self):
        for product, result in itertools.product(self.products(), ('0', '20', '21', '22', 'error', 'timeout', '', 'unknown')):
            with self.subTest(product=product, result=result):
                guard = GuardSource(product, guard_result=result)
                self.assertTrue(guard.run('customInit'))
                self.assertEqual(guard.run('customCheckAppRunning'), result == '0')
                if result != '0':
                    self.assertEqual(guard.error, 87)
        for product in self.products():
            guard = GuardSource(product, **{'$INSTDIR': r'C:\Program Files\unapproved'})
            self.assertFalse(guard.run('customCheckAppRunning'))
            self.assertEqual(guard.stopped_checks, 0)

    def test_late_silent_allusers_switch_refuses_before_old_uninstall_or_extraction(self):
        for product in self.products():
            guard = GuardSource(product)
            self.assertTrue(guard.run('customInit'))
            # With both HKLM/HKCU installs, init chooses CurrentUser but leaves
            # hasPerMachineInstallation=1. Silent already-admin installs later
            # select all-users in the section. Refuse even a matching directory.
            guard.values['$installMode'] = 'all'
            self.assertFalse(guard.run('customCheckAppRunning'))
            self.assertEqual(guard.error, 87)
            self.assertEqual(guard.stopped_checks, 0)

    def test_silent_uninstall_preinit_keeps_legitimate_current_user_check(self):
        for product in self.products():
            guard = GuardSource(product, uninstall=True, **{'$installMode': ''})
            self.assertTrue(guard.run('customCheckAppRunning'))
            self.assertEqual(guard.stopped_checks, 1)
            guard.values['$installMode'] = 'CurrentUser'  # builder initMultiUser
            self.assertTrue(guard.run('customUnInit'))
            self.assertEqual(guard.stopped_checks, 2)
            for result in ('20', '21', 'error', 'timeout'):
                guard = GuardSource(product, uninstall=True, guard_result=result, **{'$installMode': ''})
                self.assertFalse(guard.run('customCheckAppRunning'))

    def test_strict_scope_is_before_existing_checks_in_postinit_hooks(self):
        for product in self.products():
            source = GuardSource(product).source
            for hook in ('customInit', 'customUnInit'):
                instructions = [line.strip() for line in macro(source, hook).splitlines()
                                if line.strip() and not line.lstrip().startswith(';')]
                self.assertEqual(instructions[0], '!insertmacro openbutlerRequireCurrentUser')
            self.assertRegex(macro(source, 'customCheckAppRunning'),
                             r'!ifndef BUILD_UNINSTALLER\s+!insertmacro openbutlerRequireCurrentUser\s+!endif')

    def test_elevation_defense_is_scoped_to_trial_and_rc(self):
        source = (DESKTOP / 'scripts/build-preview-installer.mjs').read_text()
        block = re.search(r'if \(isolatedTrial \|\| parallelRc\) \{([^}]+)\}', source)
        self.assertIsNotNone(block)
        self.assertIn('build.nsis.allowElevation = false;', block[1])
        self.assertIn('build.nsis.allowToChangeInstallationDirectory = false;', block[1])
        self.assertEqual(source.count('build.nsis.allowElevation'), 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
