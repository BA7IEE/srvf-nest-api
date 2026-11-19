"""One entry point for guarded, disposable registration ACL assembly/withdrawal."""
import argparse
import fcntl
import os
import re
import subprocess
from pathlib import Path

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['apply','check','withdraw'])
    p.add_argument('--expected-cluster',required=True)
    args=p.parse_args()
    root=Path.cwd().resolve()
    if root.parent!=Path('/var/tmp') or not re.fullmatch(r'srvf-t[0-9]+\.[a-zA-Z0-9]{8}',root.name):
        raise SystemExit('not a disposable test stack')
    def run(file,action):
        subprocess.run(['python3',file,action,'--expected-cluster',args.expected_cluster],check=True)
    with (root/'.t44-closure-assembly.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if args.action=='apply':
            run('closure_guard.py','install')
            run('assemble.py','apply')
            run('closure_guard.py','verify')
        elif args.action=='check':
            run('assemble.py','check')
            if not (root/'t43-registration-acl-receipt.json').exists():
                raise SystemExit('registration ACL not installed')
            run('closure_guard.py','verify')
        else:
            run('assemble.py','withdraw')
            run('closure_guard.py','withdraw')
if __name__=='__main__':
    os.umask(0o077)
    main()
