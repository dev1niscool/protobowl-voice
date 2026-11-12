"""Build the distributable; only runtime files go in the installable ZIP."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parents[1]
extension = root / "extension"
manifest = json.loads((extension / "manifest.json").read_text())
output = root / "dist" / f"protobowl-voice-{manifest['version']}.zip"
output.parent.mkdir(exist_ok=True)
runtime_files = [
    "background.js", "bridge.js", "content.js", "core.js", "manifest.json",
    "popup.css", "popup.html", "popup.js",
    "icons/16.png", "icons/48.png", "icons/128.png",
]
with ZipFile(output, "w", ZIP_DEFLATED, compresslevel=9) as archive:
    for name in sorted(runtime_files):
        # Fixed, generic metadata prevents local timestamps, ownership, or
        # platform-specific attributes from entering the published artifact.
        entry = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        entry.create_system = 0
        entry.external_attr = 0x20
        entry.compress_type = ZIP_DEFLATED
        archive.writestr(entry, (extension / name).read_bytes(), compresslevel=9)
print(output.relative_to(root))
