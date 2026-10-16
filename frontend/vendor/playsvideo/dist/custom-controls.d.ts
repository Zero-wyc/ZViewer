declare global {
    interface DocumentPictureInPicture {
        requestWindow(options?: {
            width?: number;
            height?: number;
        }): Promise<Window>;
    }
    var documentPictureInPicture: DocumentPictureInPicture | undefined;
}
export interface CustomControlsOptions {
    video: HTMLVideoElement;
    container: HTMLElement;
}
export interface CustomControlsHandle {
    destroy(): void;
}
export declare function createCustomControls(options: CustomControlsOptions): CustomControlsHandle;
//# sourceMappingURL=custom-controls.d.ts.map