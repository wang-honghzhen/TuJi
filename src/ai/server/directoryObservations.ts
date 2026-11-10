import type { ContextStage, Observation } from '../contextState';

/** Older system observations had no owner tag, entry or call; actual directory reads have a call ID. */
function systemDirectoryObservation(observation:Observation):boolean {
  return observation.directoryView===true || observation.structureOnly===true
    &&!observation.callId&&!observation.entryId&&!observation.query&&observation.sources.length===0;
}

/** Resolve ownership from the displayed region, not from a generation comparison at submission. */
export function currentDirectoryObservation(stage:ContextStage,observation:Observation):boolean {
  if(!systemDirectoryObservation(observation))return true;
  if(!stage.directoryAreas&&!stage.directoryRegion)return observation.directoryView!==true;
  const main=stage.directoryAreas?.main??stage.directoryRegion;
  if(main?.observation.id===observation.id)
    return stage.entries.some(entry=>entry.category==='canvas'&&entry.id.startsWith('directory:'));
  return !!stage.directoryAreas?.cache.renderGroups.some(group=>group.observation.id===observation.id)
    &&stage.entries.some(entry=>entry.category==='canvas'&&entry.id.startsWith('directory-cache:'));
}

/** Called inside the submission transaction; pending candidates never alter installed observations. */
export function retainedDirectoryObservations(stage:ContextStage,observations:Observation[]):Observation[]{
  return observations.filter(observation=>currentDirectoryObservation(stage,observation));
}
