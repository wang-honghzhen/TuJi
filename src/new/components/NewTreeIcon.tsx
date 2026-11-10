/** Shared artwork for canvas navigation and graph documents. */
export function NewTreeIcon({ size = 30 }: { size?: number }) {
  return <img src="/brand/tree.png" alt="" aria-hidden="true" draggable={false}
    width={size} height={size} className="new-tree-icon" />;
}
