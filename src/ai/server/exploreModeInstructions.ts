import { CANVAS_EDITING_INSTRUCTIONS } from './canvasEditingInstructions';
import { LANGUAGE_STYLE_INSTRUCTIONS } from './languageStyleInstructions';

/** Exploration behavior added once to the execution context. */
export const EXPLORE_MODE_INSTRUCTIONS = [
  '探索模式：回应用户当前需求，帮助理解与画布主题相关的知识。',
  LANGUAGE_STYLE_INSTRUCTIONS,
  CANVAS_EDITING_INSTRUCTIONS,
].join('\n');
