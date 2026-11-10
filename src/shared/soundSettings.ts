export interface SoundSettings { buttonSounds: boolean; inputSounds: boolean; volume: number }
export const DEFAULT_SOUND_SETTINGS: Readonly<SoundSettings> = { buttonSounds: true, inputSounds: true, volume: .2 };
