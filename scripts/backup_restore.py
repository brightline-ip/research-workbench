"""Offline backup and isolated restore. Credentials come only from libpq environment.
Never backs up configuration, environment files or credential stores.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from contextlib import contextmanager


def pg_environment():
    return {key:value for key,value in os.environ.items() if key.startswith('PG') or key in ('PATH','LANG','LC_ALL','HOME','SystemRoot','WINDIR','TEMP','TMP')}


def sql(statement):
    result = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', statement], capture_output=True, text=True, timeout=30, env=pg_environment())
    if result.returncode: raise ValueError('Database check failed; inspect database availability and permissions.')
    return result.stdout.strip()


@contextmanager
def stopped_app():
    # Keep both locks until the entire database/filesystem operation is finished.
    process = subprocess.Popen(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env={**pg_environment(),'PGCONNECT_TIMEOUT':'5','PGOPTIONS':'-c statement_timeout=10000'})
    try:
        for key in (2, 1):
            process.stdin.write(f'SELECT pg_try_advisory_lock(727401,{key});\n'); process.stdin.flush()
            if process.stdout.readline().strip() != 't': raise ValueError('Stop the app and migration runner before backup or restore.')
        yield process
    finally:
        if process.poll() is None:
            process.stdin.close()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait()


def digest(filename):
    with filename.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()


def files(root):
    if root.is_symlink(): raise ValueError('Symlink roots are not permitted.')
    for directory, directories, filenames in os.walk(root, followlinks=False):
        for name in directories + filenames:
            candidate = Path(directory) / name
            if candidate.is_symlink(): raise ValueError('Symlinks are not permitted in backup data.')
        for name in sorted(filenames):
            candidate = Path(directory) / name
            if not candidate.is_file(): raise ValueError('Only regular files may be backed up.')
            yield candidate


def command(arguments):
    result = subprocess.run(arguments, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3600, env=pg_environment())
    if result.returncode: raise ValueError('Database backup or restore failed. No successful completion was recorded.')


def disjoint(paths):
    resolved = [Path(p).resolve() for p in paths]
    for i, left in enumerate(resolved):
        for right in resolved[i+1:]:
            if left == right or left in right.parents or right in left.parents: raise ValueError('Backup and data directories must not overlap.')


def backup(sources, projects, destination):
    disjoint([sources, projects, destination])
    if destination.exists(): raise ValueError('Backup destination must be new.')
    if not sources.is_dir() or not projects.is_dir(): raise ValueError('Both storage roots must exist.')
    destination.mkdir(parents=True, mode=0o700)
    with stopped_app() as lock:
        if sql("SELECT to_regclass('public.article_versions')") != 'article_versions': raise ValueError('The selected database is not a workbench database.')
        command(['pg_dump','--format=custom','--no-owner','--no-acl','--file',str(destination/'database.dump')])
        for name, root in [('sources', sources), ('projects', projects)]:
            (destination/name).mkdir()
            for item in files(root):
                target = destination/name/item.relative_to(root)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(item, target)
        manifest = {'format':1,'database':sql('SELECT current_database()'),'files':{f.relative_to(destination).as_posix():digest(f) for f in files(destination)}}
        if lock.poll() is not None: raise ValueError('The backup lock connection was lost; backup is incomplete.')
        # Written last: a directory without this marker is not a successful backup.
        (destination/'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return {'status':'COMPLETE','files':len(manifest['files'])}


def validate(directory):
    if (directory/'manifest.json').stat().st_size > 32*1024*1024: raise ValueError('Backup manifest is too large.')
    manifest = json.loads((directory/'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('format') != 1 or 'database.dump' not in manifest.get('files', {}): raise ValueError('Invalid backup manifest.')
    actual = {f.relative_to(directory).as_posix() for f in files(directory)} - {'manifest.json'}
    if actual != set(manifest['files']): raise ValueError('Backup file coverage mismatch.')
    for name, expected in manifest['files'].items():
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or (name != 'database.dump' and relative.parts[0] not in ('sources','projects')): raise ValueError('Unsafe backup path.')
        if digest(directory/relative) != expected: raise ValueError('Backup integrity check failed.')
    return manifest


def restore(directory, sources, projects):
    disjoint([directory,sources,projects])
    validate(directory)  # Verify all bytes before creating target directories or changing the database.
    if sources.exists() or projects.exists(): raise ValueError('Restore storage destinations must be new.')
    database = sql('SELECT current_database()')
    if not re.fullmatch(r'rw_(restore|audit)_[a-z0-9_]+',database): raise ValueError('Restore only permits a dedicated rw_restore_ or rw_audit_ database.')
    with stopped_app():
        if sql("SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')") != '0': raise ValueError('Restore database must be empty.')
        for name, target in [('sources',sources),('projects',projects)]:
            shutil.copytree(directory/name, target)
        command(['pg_restore','--dbname',database,'--no-owner','--no-acl','--exit-on-error','--single-transaction',str(directory/'database.dump')])
        for name, expected in validate(directory)['files'].items():
            if name == 'database.dump': continue
            kind, relative = name.split('/',1)
            if digest((sources if kind=='sources' else projects)/relative) != expected: raise ValueError('Restored file integrity check failed.')
    return {'status':'COMPLETE','database':database,'note':'Isolated restore only. Validate the restored application before any cutover.'}


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=['backup','validate','restore'])
    parser.add_argument('--directory',type=Path,required=True)
    parser.add_argument('--sources',type=Path)
    parser.add_argument('--projects',type=Path)
    args=parser.parse_args()
    try:
        if args.operation=='validate': result={'status':'VALID','files':len(validate(args.directory)['files'])}
        else:
            if not args.sources or not args.projects: raise ValueError('Both storage roots are required.')
            result=backup(args.sources,args.projects,args.directory) if args.operation=='backup' else restore(args.directory,args.sources,args.projects)
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'status':'FAILED','reason':str(error) if isinstance(error,ValueError) else 'Backup operation failed; no completion is certified.'}), file=sys.stderr)
        sys.exit(1)
