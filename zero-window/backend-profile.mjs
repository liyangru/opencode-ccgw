import path from 'node:path'
export function backendEnvironment(original,home){
  if(!home||!path.isAbsolute(home))throw Error('Absolute backend profile directory required')
  const env={...original}
  for(const k of ['OPENCODE_CONFIG','OPENCODE_CONFIG_CONTENT','CCGW_SERVICE_FILE'])delete env[k]
  return {...env,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData','Roaming'),LOCALAPPDATA:path.join(home,'AppData','Local'),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local','share'),XDG_STATE_HOME:path.join(home,'.local','state'),XDG_CACHE_HOME:path.join(home,'.cache'),OPENCODE_CONFIG_DIR:path.join(home,'.config','opencode')}
}
