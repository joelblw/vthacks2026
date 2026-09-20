import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare_media', Path(__file__).resolve().parents[1] / 'tools/prepare_media.py')
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.card = Path(self.temp.name) / 'card'
        self.stage = Path(self.temp.name) / 'staged'
        files = {'arch/x86_64/airootfs.sfs': 'untouched-image',
                 'loader/entries/01-archiso-linux.conf': 'title Arch\nsort-key 01\nlinux /arch/boot/x86_64/vmlinuz-linux\ninitrd /arch/boot/x86_64/initramfs-linux.img\noptions archisobasedir=arch\n',
                 'loader/loader.conf': 'timeout 15\ndefault 01-archiso-linux.conf\n',
                 'boot/syslinux/archiso_sys.cfg': 'DEFAULT arch\nTIMEOUT 150\n',
                 'boot/syslinux/archiso_sys-linux.cfg': 'LABEL arch\nAPPEND archisobasedir=arch\n'}
        for relative, content in files.items():
            path = self.card / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)

    def test_staging_and_application_keep_normal_entry_and_image(self):
        normal = (self.card / 'loader/entries/01-archiso-linux.conf').read_bytes()
        media.stage(self.card, self.stage)
        self.assertFalse((self.card / 'loader/entries/00-linuxlink.conf').exists())
        media.apply(self.card, self.stage)
        self.assertEqual((self.card / 'loader/entries/01-archiso-linux.conf').read_bytes(), normal)
        self.assertEqual((self.card / 'arch/x86_64/airootfs.sfs').read_text(), 'untouched-image')
        self.assertIn('systemd.mount-extra=', (self.card / 'loader/entries/00-linuxlink.conf').read_text())
        self.assertIn('default 00-linuxlink.conf', (self.card / 'loader/loader.conf').read_text())
        self.assertEqual(len(list((self.card / 'linuxlink').glob('backup-*'))), 1)

    def test_changed_card_is_not_overwritten(self):
        media.stage(self.card, self.stage)
        path = self.card / 'loader/loader.conf'
        path.write_text('user-change')
        with self.assertRaisesRegex(ValueError, 'Card changed'):
            media.apply(self.card, self.stage)
        self.assertEqual(path.read_text(), 'user-change')
        self.assertFalse((self.card / 'linuxlink').exists())

    def test_paths_cannot_escape_root(self):
        with self.assertRaises(ValueError):
            media.under(self.card, '../elsewhere')

    def test_boot_files_only_does_not_require_or_create_image(self):
        image = self.card / 'arch/x86_64/airootfs.sfs'
        image.unlink()
        with self.assertRaisesRegex(ValueError, 'Expected Arch'):
            media.stage(self.card, self.stage)
        media.stage(self.card, self.stage, boot_files_only=True)
        media.apply(self.card, self.stage, boot_files_only=True)
        self.assertFalse(image.exists())
        self.assertIn('default 00-linuxlink.conf', (self.card / 'loader/loader.conf').read_text())


if __name__ == '__main__':
    unittest.main()
