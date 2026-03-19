export class MenuController {
  createSubitemsPanel(_file: any) { return { refresh: () => {} } as any; }
  createNoteReferencesPanel(_file: any) { return { refresh: () => {} } as any; }
  createHeaderBadges(_file: any, _leaf?: any): any[] { return []; }
  getPanelBuilder() { return { refreshNoteReferencesPanel: (_f:any,_e:HTMLElement)=>{} } as any; }
}

export function addSafeClickListener(_el: HTMLElement, _cb: (ev: any)=>void) { }
