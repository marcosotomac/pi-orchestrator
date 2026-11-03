import sys
sys.dont_write_bytecode = True
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile
import stat


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent.parent / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load('installer', 'install-antigravity.py')
browser = load('browser', 'antigravity-browser.py')


class InstallerTests(unittest.TestCase):
    def archive(self, entries, expected, succeeds=False):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / 'fixture.zip'
            destination = root / 'release'
            destination.mkdir()
            with zipfile.ZipFile(archive, 'w') as zipped:
                for name, value in entries:
                    zipped.writestr(name, value)
            if succeeds:
                installer.extract(archive, destination, expected)
                self.assertEqual((destination / 'server').read_bytes(), b'fixture')
            else:
                with self.assertRaises(ValueError):
                    installer.extract(archive, destination, expected)
            self.assertFalse((root / 'escape').exists())

    def test_exact_members(self):
        self.archive([('server', b'fixture')], {'server': 7}, True)

    def test_traversal(self):
        self.archive([('../escape', b'fixture')], {'server': 7})

    def test_wrong_size(self):
        self.archive([('server', b'fixture')], {'server': 8})

    def test_unexpected_member(self):
        self.archive([('server', b'fixture'), ('other', b'x')], {'server': 7})

    def test_symlink(self):
        info = zipfile.ZipInfo('server')
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.archive([(info, b'fixture')], {'server': 7})

    def test_oauth_url_allowlist(self):
        self.assertTrue(browser.valid_google_authorization('https://accounts.google.com/o/oauth2/v2/auth?state=fixture'))
        for url in ['https://evil.test/o/oauth2/auth', 'http://accounts.google.com/o/oauth2/auth', 'https://accounts.google.com.evil.test/o/oauth2/auth', 'https://user@accounts.google.com/o/oauth2/auth', 'https://accounts.google.com:444/o/oauth2/auth', 'file:///etc/passwd']:
            self.assertFalse(browser.valid_google_authorization(url))


if __name__ == '__main__':
    unittest.main()
