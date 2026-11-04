export const SCENE_IDS = ['menu', 'table'] as const;

export type SceneId = (typeof SCENE_IDS)[number];

export function isSceneId(value: string): value is SceneId {
  return (SCENE_IDS as readonly string[]).includes(value);
}
