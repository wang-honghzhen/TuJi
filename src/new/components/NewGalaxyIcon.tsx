import { GALAXY_MARK_SIZE, NEW_SESSION_MARK, NEW_SESSION_MARK_ACTIVE } from '../newGalaxyMark';

/** Shared star layers and hover animation for canvas buttons and session nodes. */
export function NewGalaxyIcon({ size = GALAXY_MARK_SIZE, phase = 0 }: { size?: number; phase?: number }) {
  return <span className="block new-mark-spin-slow" style={{ width: size, height: size, animationDelay: `${-phase * 19}s` }} aria-hidden="true">
    <span className="block relative new-mark-spin-hover" style={{ width: size, height: size }}>
      <img src={NEW_SESSION_MARK} alt="" draggable={false} width={size} height={size} className="new-mark-layer new-mark-layer-base select-none" />
      <img src={NEW_SESSION_MARK_ACTIVE} alt="" draggable={false} width={size} height={size} className="new-mark-layer new-mark-layer-active select-none" />
    </span>
  </span>;
}
