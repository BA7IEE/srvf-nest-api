import os,pathlib,subprocess
p=pathlib.Path(__file__).resolve().parent
subprocess.run(["python3",str(p/"necessity.py")],check=True)
subprocess.run(['docker','exec','-i',os.environ['CONTAINER'],'psql','-XqAt','-U','postgres','-d','srvf_staging','-v','expected_cluster='+os.environ['EXPECTED_CLUSTER']],input=(p/'rollback.sql').read_bytes(),check=True)
