// Los .svg se resuelven como assets de Metro (módulo numérico para
// require/import), consumibles por useSVG de Skia vía expo-asset.
declare module '*.svg' {
  const assetId: number;
  export default assetId;
}
