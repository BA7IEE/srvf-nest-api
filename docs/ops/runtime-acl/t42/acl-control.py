import subprocess,re,pathlib
n=pathlib.Path('name').read_text().strip()
assert re.fullmatch(r'srvf-t42-[a-zA-Z0-9]{8}',n)
base=['docker','exec','-i',n+'-pg','psql','-XAtq','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-U','postgres','-d','srvf_staging']
sql='SELECT "id","activityId","memberId","registrationId","sessionId","currentRevision","currentStatusCode","currentPositionId","capacityReservationId","populationIncluded","version" FROM public."ActivityParticipationIdentity" WHERE false ORDER BY "id"'
for lock in [False,True]:
 cmd="BEGIN; SET LOCAL ROLE srvf_dp_acceptance_runtime; "+sql+(" FOR UPDATE" if lock else "")+"; ROLLBACK;"
 result=subprocess.run(base,input=cmd,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 state=re.search(r'ERROR:\s+([A-Z0-9]{5}):\s+permission denied for table (\w+)',result.stderr)
 print('lock='+str(lock),'psql_exit='+str(result.returncode),'error='+('/'.join(state.groups()) if state else 'none'))
 if lock:
  assert result.returncode==3 and state and state.groups()==('42501','ActivityParticipationIdentity')
 else:
  assert result.returncode==0
