import { useEffect } from 'react';
import { useAiStore } from '@/ai/client';
import { FloatingOrb } from './FloatingOrb';
import { UtilityPanel } from './UtilityPanel';
import '@/ai/ui/ai.css';

export function DesktopAuxiliary() {
  const role = window.tujiDesktop?.role;
  useEffect(() => useAiStore.getState().connect(), []);
  return role === 'orb' ? <FloatingOrb /> : <UtilityPanel />;
}
