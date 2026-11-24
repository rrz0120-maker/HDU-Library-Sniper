from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "userscript-v9"))
import browser as v9
from mock_huitu import ROOT

V10 = ROOT / "userscripts/HDU_iPad_V10.0_Lite.user.js"
def install(mock, version):
    mock.files.setdefault("baseline", mock.files["v9"])
    mock.files["v9"] = V10.read_bytes() if version == 10 else mock.files["baseline"]
    v9.HOST = f"#hdu-ipad-v{version}-lite"
