"""Build the distributable; only runtime files go in the installable ZIP."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import json
import shutil

root = Path(__file__).resolve().parents[1]
extension = root / "extension"
manifest = json.loads((extension / "manifest.json").read_text())
dist = root / "dist"
dist.mkdir(exist_ok=True)
runtime_files = [
    "background.js", "bridge.js", "content.js", "core.js", "manifest.json",
    "popup.css", "popup.html", "popup.js",
    "icons/16.png", "icons/48.png", "icons/128.png",
]

def write_zip(output, files):
    with ZipFile(output, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            # Fixed, generic metadata excludes local times and ownership.
            entry = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 0
            entry.external_attr = 0x20
            entry.compress_type = ZIP_DEFLATED
            archive.writestr(entry, data, compresslevel=9)
    print(output.relative_to(root))


chrome_files = {name: (extension / name).read_bytes() for name in runtime_files}
write_zip(dist / f"protobowl-voice-{manifest['version']}.zip", chrome_files)

safari_files = dict(chrome_files)
for name in ["manifest.json", "background.js", "speech.js", "popup-transport.js"]:
    safari_files[name] = (root / "safari" / name).read_bytes()
assert json.loads(safari_files["manifest.json"])["version"] == manifest["version"]
html = safari_files["popup.html"].decode()
html = html.replace('<script src="popup.js" defer></script>',
                    '<script src="core.js" defer></script>\n'
                    '    <script src="speech.js" defer></script>\n'
                    '    <script src="popup-transport.js" defer></script>\n'
                    '    <script src="popup.js" defer></script>')
safari_files["popup.html"] = html.encode()
safari_folder = dist / "safari-extension"
if safari_folder.exists():
    shutil.rmtree(safari_folder)
for name, data in safari_files.items():
    target = safari_folder / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
write_zip(dist / f"protobowl-voice-safari-extension-{manifest['version']}.zip", safari_files)
