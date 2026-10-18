// Chimes are synthesized with Web Audio, so there are no audio files to load.
// Browsers only allow audio after a user gesture, so call unlockAudio() from a click.

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

export async function unlockAudio(): Promise<boolean> {
  const c = getContext();
  if (!c) return false;
  if (c.state === 'suspended') await c.resume().catch(() => {});
  return c.state === 'running';
}

export function audioUnlocked(): boolean {
  return ctx?.state === 'running';
}

/** Gentle three-note "ding-dong-ding" announcement chime. */
export function playChime(volume = 0.35): void {
  const c = getContext();
  if (!c || c.state !== 'running') return;
  const notes = [659.25, 523.25, 783.99]; // E5, C5, G5
  notes.forEach((freq, i) => {
    const t = c.currentTime + i * 0.32;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 1.2);
  });
}

export function vibrate(pattern: number[] = [300, 120, 300, 120, 600]): void {
  // Chrome blocks (and logs) vibration until the page has had a user tap.
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  if ('vibrate' in navigator && (activation?.hasBeenActive ?? true)) navigator.vibrate(pattern);
}

/** Say `text` aloud with a voice for `lang` (a BCP 47 tag like "es-US"), if the device has one. */
export function speak(text: string, lang = 'en-US'): void {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  const base = lang.split('-')[0];
  const voices = window.speechSynthesis.getVoices();
  u.voice = voices.find((v) => v.lang === lang) ?? voices.find((v) => v.lang.toLowerCase().startsWith(base)) ?? null;
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
}
