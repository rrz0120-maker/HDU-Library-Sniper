"""Build a deterministic Userscripts ZIP from the tested JS and two user documents."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
root = Path(__file__).resolve().parents[1]
script = "HDU_iPad_V10.0_Lite.user.js"
files = {script: root/"userscripts"/script, "中文安装说明.md": root/"docs/IPAD-V10-INSTALL.md",
         "变更说明.md": root/"docs/IPAD-V10-CHANGES.md"}
target = root/"releases/HDU_iPad_V10.0_Lite.zip"
target.parent.mkdir(exist_ok=True)
with ZipFile(target, "w") as package:
    for name, source in files.items():
        entry = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        entry.external_attr = 0o100644 << 16
        package.writestr(entry, source.read_bytes(), compress_type=ZIP_DEFLATED)
with ZipFile(target) as package:
    assert package.testzip() is None and package.namelist() == list(files)
    assert all(package.read(name) == source.read_bytes() for name, source in files.items())
