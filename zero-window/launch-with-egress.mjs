// Receives the existing CLI and arguments from its machine-local launcher.
// Profiles/provider keys stay unchanged. The egress key exists only in memory.
import {spawn} from 'node:child_process'
import {readEgressKey,egressEnvironment} from '../egress.mjs'
import {backendEnvironment} from './backend-profile.mjs'
const [executable,...args]=process.argv.slice(2)
if(!executable)throw new Error('OpenCode executable is required')
const profile=process.env.CCGW_PROFILE_HOME?backendEnvironment(process.env,process.env.CCGW_PROFILE_HOME):process.env
const env=egressEnvironment(profile,process.env.CCGW_EGRESS_URL,readEgressKey(process.env.CCGW_EGRESS_KEY_DIR))
const child=spawn(executable,args,{env,windowsHide:true,stdio:'inherit'})
child.on('error',()=>{console.error('Unable to start the OpenCode backend');process.exitCode=1})
child.on('exit',code=>{process.exitCode=code??1})
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill())
