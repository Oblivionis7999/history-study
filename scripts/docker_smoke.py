"""Disposable Compose integration check. Refuses to run against a non-CI checkout."""
import datetime
import json
import os
import subprocess
import time
from pathlib import Path
import httpx
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true': raise SystemExit('This harness requires a disposable GitHub Actions runner.')
    root = Path(__file__).resolve().parents[1]
    if (root / '.env').exists(): raise SystemExit('Refusing to replace an existing .env.')
    (root / '.env').write_text('DEV_MODE=0\nPORT=8080\n')
    tls = root / '.runtime/ci-tls'; tls.mkdir(parents=True, exist_ok=True)
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
    cert = x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(private.public_key()).serial_number(x509.random_serial_number()).not_valid_before(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1)).not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]), False).sign(private, hashes.SHA256())
    (tls / 'cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (tls / 'key.pem').write_bytes(private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    cmd = ['docker', 'compose', '-p', 'study-v2-ci', '-f', 'compose.yaml', '-f', 'deploy/compose.ci.yaml']
    results = {}
    def run(*args, **kwargs): return subprocess.run(cmd + list(args), cwd=root, check=True, **kwargs)
    try:
        run('config', '--quiet'); results['config'] = 'PASS'
        run('build'); results['build'] = 'PASS'
        run('up', '-d', '--wait', '--wait-timeout', '180'); results['startup_health'] = 'PASS'
        password = 'isolated-ci-password-value'
        run('exec', '-T', 'api', 'python', '-m', 'backend.accounts', 'create-admin', '--username', 'ci_admin', '--password-stdin', input=password + '\n', text=True, stdout=subprocess.DEVNULL)
        # This HTTPS endpoint and certificate exist only on this disposable runner.
        with httpx.Client(base_url='https://localhost:8443', verify=False, headers={'X-Study-Request': '1', 'Origin': 'https://localhost:8443'}, timeout=20) as c:
            assert c.get('/api/health').json()['bank_count'] == 700
            assert c.get('/api/bank').status_code == 401
            r = c.post('/api/auth/login', json={'username':'ci_admin','password':password}); assert r.status_code == 200
            assert 'Secure' in r.headers['set-cookie']; results['https_login_cookie'] = 'PASS'
            for username in ['ci_alice','ci_bob']:
                assert c.post('/api/admin/users', json={'username':username,'display_name':username,'password':password}).status_code == 200
            bank = c.get('/api/bank').json(); assert len(bank['questions']) == 700
            q = bank['questions'][0]
            r = c.post('/api/ai/chat', json={'question_id':q['id'],'order':[o['id'] for o in q['options']], 'selected':[], 'action':'explain'})
            assert '"type": "done"' in r.text and 'Isolated CI explanation' in r.text; results['ai_mock'] = 'PASS'
            assert c.get('/api/export').status_code == 404
            assert 'Content-Security-Policy' in c.get('/').headers
            run('restart', 'api')
            for attempt in range(30):
                try:
                    if c.get('/api/health').status_code == 200: break
                except httpx.HTTPError: pass
                time.sleep(1)
            assert c.get('/api/auth/me').json()['user']['username'] == 'ci_admin'
            assert len(c.get('/api/admin').json()['users']) == 3; results['restart_accounts_sessions_persist'] = 'PASS'
            for username in ['ci_alice','ci_bob']:
                c.post('/api/auth/logout')
                assert c.post('/api/auth/login', json={'username':username,'password':password}).status_code == 200
                assert c.get('/api/admin').status_code == 403
                assert c.get('/api/bank').status_code == 200
            results['multiple_accounts_and_authorization'] = 'PASS'
    finally:
        folder = root / 'artifacts'; folder.mkdir(exist_ok=True)
        (folder / 'docker-smoke-result.json').write_text(json.dumps(results, indent=2))
        # The project name is fixed to this isolated harness; never touches production volumes.
        run('down', '--volumes', '--remove-orphans')

if __name__ == '__main__': main()
