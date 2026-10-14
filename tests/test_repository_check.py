import importlib.util
from pathlib import Path

spec=importlib.util.spec_from_file_location('checker',Path('scripts/check_repository.py'))
checker=importlib.util.module_from_spec(spec); spec.loader.exec_module(checker)

def test_path_detector_distinguishes_routes_from_personal_paths():
    assert not checker.inspect_blob('routes.py',b"'/api/admin/users/{uid}'")
    # Construct test paths without embedding a real user's path in the source.
    for sample in [chr(67)+':'+chr(92)+'Users'+chr(92)+'someone', '/'+ 'Users/someone/file', '/'+ 'home/someone/file']:
        assert any(f['kind']=='machine_path' for f in checker.inspect_blob('sample.txt',sample.encode()))

def test_learning_backups_and_recovery_keys_are_never_publishable():
    assert any(f['kind']=='study_backup' for f in checker.inspect_blob('accidental.json',b'{"format":"history-study-encrypted-v2"}'))
    assert any(f['kind']=='private_file' for f in checker.inspect_blob('study-recovery-key.txt',b'synthetic'))
