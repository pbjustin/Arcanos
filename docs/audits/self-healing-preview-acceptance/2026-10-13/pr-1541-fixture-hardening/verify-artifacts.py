"""Independently verify final committed-source and receipt bytes without executing fixtures."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

repository = Path(sys.argv[1]).resolve()
directory = Path(sys.argv[2]).resolve()
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repository, text=True).strip()
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
matrix = json.loads((directory / 'matrix.json').read_text())
assert matrix['status'] == 'PASS'
assert matrix['sourceSha'] == head
assert matrix['relevantWorktreeDirty'] is False
artifacts = []
for item in matrix['files']:
    observed = digest(repository / item['path'])
    committed = subprocess.check_output(['git', 'show', f"{head}:{item['path']}"], cwd=repository)
    assert observed == item['sha256'] == item['headSha256'] == hashlib.sha256(committed).hexdigest()
for major, expected in [(17, 40), (18, 41)]:
    result = next(item for item in matrix['results'] if item['postgresMajor'] == major)
    assert result['status'] == 'PASS' and result['caseCount'] == expected
    assert result['network'] == 'none' and result['publishedPorts'] == 0
    assert result['credentialEnvironment'] == 'empty' and result['containerRemoved'] is True
    proof_path = directory / f'pg{major}' / 'proof.json'
    proof = json.loads(proof_path.read_text())
    assert proof['sourceSha'] == head and proof['relevantWorktreeDirty'] is False
    assert proof['postgresVersion'].startswith(f'{major}.') and proof['nodeVersion'] == 'v24.18.1'
    assert proof['syntheticGithubAuthority'] is True and proof['defaultNetworkRouteAbsent'] is True
    assert proof['status'] == 'PASS' and len(proof['cases']) == expected
    assert proof['sourceContextSha256'] == digest(directory / 'source-context.json')
    assert proof['teardown'] == {'postgresStopped': True, 'fixtureDirectoryRemoved': True, 'pausedBackendsRemaining': 0}
    assert proof['setupChecks'] == [{'name': 'database-server-key-mismatch', 'status': 'PASS', 'postgresStartupRejected': True, 'collectorExecuted': False}]
    for case in proof['cases']:
        assert case['status'] == 'PASS' and case['databaseFingerprintUnchanged'] is True
        assert case['collectorSessionsRemaining'] == 0
        if case['name'] == 'collector-interrupted-during-backend-pause':
            assert 0 <= case['elapsedMs'] < 5000 and case['collectorSignal'] == 'SIGTERM'
            assert case['injectedFault']['durationMs'] == 6500
            assert 'receiptSha256' not in case
        if 'receiptSha256' in case:
            path = proof_path.parent / (case['name'] + '.json')
            assert digest(path) == case['receiptSha256']
            assert json.loads(path.read_text())['status'] == case['receiptStatus']
    for path in sorted(proof_path.parent.glob('*.json')):
        artifacts.append({'path': str(path.relative_to(directory)), 'sha256': digest(path)})
for name in ['matrix.json', 'source-context.json']:
    artifacts.append({'path': name, 'sha256': digest(directory / name)})
assert len(artifacts) - 4 == 69
print(json.dumps({'status': 'PASS', 'sourceSha': head, 'independentlyVerifiedSources': len(matrix['files']),
                  'independentlyVerifiedReceipts': len(artifacts) - 4,
                  'collectorCases': 81, 'setupChecks': 2, 'artifacts': artifacts}, indent=2))
