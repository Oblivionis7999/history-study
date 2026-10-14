"""Create a portable source package without local state or credentials."""
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path
from check_repository import inspect_blob

ROOT=Path(__file__).resolve().parents[1]
def package():
    output=ROOT/'artifacts/history-study-deploy.zip'; output.parent.mkdir(exist_ok=True)
    # Only reviewed Git source and built static resources; never collect arbitrary local folders.
    names=subprocess.check_output(['git','ls-files','-z'],cwd=ROOT).decode('utf-8').split('\0')
    files=[ROOT/name for name in names if name]
    required=['V2_OPTIMIZATION_REPORT.md','LOCAL_DATA_ARCHITECTURE.md','ACCOUNT_SECURITY.md','DATA_MIGRATION.md','MOBILE_TABLET_TEST_REPORT.md','DEPLOYMENT_V2.md','public/manifest.webmanifest']
    if any(name not in names for name in required): raise ValueError('Stage all V2 documentation and public assets before packaging.')
    findings=[]
    for p in files:
        findings.extend(inspect_blob(p.relative_to(ROOT).as_posix(),p.read_bytes()))
    if findings: raise ValueError(json.dumps(findings,ensure_ascii=True))
    if not (ROOT/'dist/sw.js').is_file(): raise ValueError('Run npm run build before packaging.')
    files += [p for p in (ROOT/'dist').rglob('*') if p.is_file()]
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
        for p in sorted(set(files)):
            if not p.is_file(): raise FileNotFoundError(p)
            archive.write(p,'history-study/'+p.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        names=archive.namelist()
        assert not any(set(Path(name).parts)&{'.git','.env','.runtime','.venv','node_modules','__pycache__','artifacts'} for name in names)
        assert len(json.loads(archive.read('history-study/data/questions.json'))['questions'])==700
    sha=hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.sha256').write_text(sha+'  '+output.name+'\n',encoding='ascii')
    print(json.dumps({'path':str(output),'bytes':output.stat().st_size,'files':len(files),'sha256':sha}))

if __name__=='__main__': package()
