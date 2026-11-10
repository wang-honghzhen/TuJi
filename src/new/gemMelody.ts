export const GEM_NOTES = ['C5', 'D5', 'E5', 'G5', 'A5', 'C6'] as const;
export interface GemCue { note: typeof GEM_NOTES[number]; strength: number }

// Three pentatonic phrases share a home note. Timing selects the phrase while
// its position follows the user's input, so repeated intervals form a melody.
const phrases = {
  quick: [0, 1, 2, 3, 4, 5, 4, 3, 2, 1],
  steady: [0, 2, 3, 4, 3, 2, 1, 2],
  spaced: [0, 3, 2, 1, 0, 2, 1, 0],
};

export class GemMelody {
  private lastAt = -Infinity;
  private step = 0;

  next(triggeredAt: number): GemCue {
    const gap = triggeredAt - this.lastAt;
    this.lastAt = triggeredAt;
    if (gap >= 1600 || gap < 0) {
      this.step = 0;
      return { note: GEM_NOTES[0], strength: 1 };
    }
    this.step++;
    const pace = gap < 180 ? 'quick' : gap < 650 ? 'steady' : 'spaced';
    const phrase = phrases[pace];
    return { note: GEM_NOTES[phrase[this.step % phrase.length]],
      strength: pace === 'quick' ? .76 : pace === 'steady' ? .9 : 1 };
  }

  reset() { this.lastAt = -Infinity; this.step = 0; }
}
