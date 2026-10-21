// The Studio's own controls, shared by the Studio app and Spatial Data Studio for Cirro
// so the two show the same display settings. Tailwind-styled: see the README.
export { EmbeddingSettings, SpatialSettings } from './canvas/Settings';
export { default as ColorBySelect } from './canvas/ColorBySelect';
export { default as ObsFieldSelect } from './ObsFieldSelect';
export { default as VarNameSelect } from './VarNameSelect';
export { default as ColorSwatchPicker } from './ColorSwatchPicker';
export { default as PanelTabs, type PanelTab } from './PanelTabs';
export { useClickOutside } from './useClickOutside';
