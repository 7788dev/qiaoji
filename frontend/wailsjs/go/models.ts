export namespace config {
	
	export class WindowState {
	    width: number;
	    height: number;
	    x: number;
	    y: number;
	    maximised: boolean;
	
	    static createFrom(source: any = {}) {
	        return new WindowState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.width = source["width"];
	        this.height = source["height"];
	        this.x = source["x"];
	        this.y = source["y"];
	        this.maximised = source["maximised"];
	    }
	}
	export class Settings {
	    vaultPath: string;
	    theme: string;
	    language: string;
	    zoom: number;
	    autostart: boolean;
	    minimiseToTray: boolean;
	    closeToTray: boolean;
	    autoUpdate: boolean;
	    hardwareAcceleration: boolean;
	    fontFamily: string;
	    fontSize: number;
	    lineHeight: number;
	    tabSize: number;
	    showLineNumbers: boolean;
	    autoSave: boolean;
	    autoSaveDelayMs: number;
	    autoPairing: boolean;
	    editorWidth: string;
	    listView: string;
	    sortBy: string;
	    showLivePreview: boolean;
	    exportDir: string;
	    lastExportFormat: string;
	    window: WindowState;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.vaultPath = source["vaultPath"];
	        this.theme = source["theme"];
	        this.language = source["language"];
	        this.zoom = source["zoom"];
	        this.autostart = source["autostart"];
	        this.minimiseToTray = source["minimiseToTray"];
	        this.closeToTray = source["closeToTray"];
	        this.autoUpdate = source["autoUpdate"];
	        this.hardwareAcceleration = source["hardwareAcceleration"];
	        this.fontFamily = source["fontFamily"];
	        this.fontSize = source["fontSize"];
	        this.lineHeight = source["lineHeight"];
	        this.tabSize = source["tabSize"];
	        this.showLineNumbers = source["showLineNumbers"];
	        this.autoSave = source["autoSave"];
	        this.autoSaveDelayMs = source["autoSaveDelayMs"];
	        this.autoPairing = source["autoPairing"];
	        this.editorWidth = source["editorWidth"];
	        this.listView = source["listView"];
	        this.sortBy = source["sortBy"];
	        this.showLivePreview = source["showLivePreview"];
	        this.exportDir = source["exportDir"];
	        this.lastExportFormat = source["lastExportFormat"];
	        this.window = this.convertValues(source["window"], WindowState);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace exporter {
	
	export class Request {
	    format: string;
	    title: string;
	    fileName: string;
	    dir: string;
	    markdown: string;
	    bodyHtml: string;
	    hasMath: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Request(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.format = source["format"];
	        this.title = source["title"];
	        this.fileName = source["fileName"];
	        this.dir = source["dir"];
	        this.markdown = source["markdown"];
	        this.bodyHtml = source["bodyHtml"];
	        this.hasMath = source["hasMath"];
	    }
	}

}

export namespace index {
	
	export class Hit {
	    id: string;
	    path: string;
	    title: string;
	    titleHtml: string;
	    folder: string;
	    snippet: string;
	    // Go type: time
	    updated: any;
	    favorite: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Hit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.path = source["path"];
	        this.title = source["title"];
	        this.titleHtml = source["titleHtml"];
	        this.folder = source["folder"];
	        this.snippet = source["snippet"];
	        this.updated = this.convertValues(source["updated"], null);
	        this.favorite = source["favorite"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Query {
	    scope: string;
	    value: string;
	    sortBy: string;
	    limit: number;
	
	    static createFrom(source: any = {}) {
	        return new Query(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.scope = source["scope"];
	        this.value = source["value"];
	        this.sortBy = source["sortBy"];
	        this.limit = source["limit"];
	    }
	}

}

export namespace main {
	
	export class Stats {
	    notes: number;
	    words: number;
	    folders: number;
	    tags: number;
	    trash: number;
	    bytes: number;
	
	    static createFrom(source: any = {}) {
	        return new Stats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.notes = source["notes"];
	        this.words = source["words"];
	        this.folders = source["folders"];
	        this.tags = source["tags"];
	        this.trash = source["trash"];
	        this.bytes = source["bytes"];
	    }
	}
	export class Bootstrap {
	    settings: config.Settings;
	    vaultReady: boolean;
	    vaultPath: string;
	    version: string;
	    error: string;
	    stats: Stats;
	
	    static createFrom(source: any = {}) {
	        return new Bootstrap(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.settings = this.convertValues(source["settings"], config.Settings);
	        this.vaultReady = source["vaultReady"];
	        this.vaultPath = source["vaultPath"];
	        this.version = source["version"];
	        this.error = source["error"];
	        this.stats = this.convertValues(source["stats"], Stats);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SidebarData {
	    folders: store.Folder[];
	    tags: store.Tag[];
	    stats: Stats;
	
	    static createFrom(source: any = {}) {
	        return new SidebarData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.folders = this.convertValues(source["folders"], store.Folder);
	        this.tags = this.convertValues(source["tags"], store.Tag);
	        this.stats = this.convertValues(source["stats"], Stats);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class UpdateInfo {
	    currentVersion: string;
	    latestVersion: string;
	    available: boolean;
	    releaseUrl: string;
	    installerUrl: string;
	    sha256: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.currentVersion = source["currentVersion"];
	        this.latestVersion = source["latestVersion"];
	        this.available = source["available"];
	        this.releaseUrl = source["releaseUrl"];
	        this.installerUrl = source["installerUrl"];
	        this.sha256 = source["sha256"];
	    }
	}

}

export namespace store {
	
	export class Folder {
	    name: string;
	    path: string;
	    count: number;
	
	    static createFrom(source: any = {}) {
	        return new Folder(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.count = source["count"];
	    }
	}
	export class Meta {
	    id: string;
	    title: string;
	    folder: string;
	    path: string;
	    tags: string[];
	    // Go type: time
	    created: any;
	    // Go type: time
	    updated: any;
	    favorite: boolean;
	    excerpt: string;
	    words: number;
	    size: number;
	    revision: string;
	
	    static createFrom(source: any = {}) {
	        return new Meta(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.folder = source["folder"];
	        this.path = source["path"];
	        this.tags = source["tags"];
	        this.created = this.convertValues(source["created"], null);
	        this.updated = this.convertValues(source["updated"], null);
	        this.favorite = source["favorite"];
	        this.excerpt = source["excerpt"];
	        this.words = source["words"];
	        this.size = source["size"];
	        this.revision = source["revision"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Note {
	    id: string;
	    title: string;
	    folder: string;
	    path: string;
	    tags: string[];
	    // Go type: time
	    created: any;
	    // Go type: time
	    updated: any;
	    favorite: boolean;
	    excerpt: string;
	    words: number;
	    size: number;
	    revision: string;
	    content: string;
	
	    static createFrom(source: any = {}) {
	        return new Note(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.folder = source["folder"];
	        this.path = source["path"];
	        this.tags = source["tags"];
	        this.created = this.convertValues(source["created"], null);
	        this.updated = this.convertValues(source["updated"], null);
	        this.favorite = source["favorite"];
	        this.excerpt = source["excerpt"];
	        this.words = source["words"];
	        this.size = source["size"];
	        this.revision = source["revision"];
	        this.content = source["content"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Restored {
	    kind: string;
	    note: Note;
	    folder: string;
	    notes: number;
	
	    static createFrom(source: any = {}) {
	        return new Restored(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.note = this.convertValues(source["note"], Note);
	        this.folder = source["folder"];
	        this.notes = source["notes"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Tag {
	    name: string;
	    count: number;
	
	    static createFrom(source: any = {}) {
	        return new Tag(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.count = source["count"];
	    }
	}
	export class TrashItem {
	    id: string;
	    kind: string;
	    title: string;
	    folder: string;
	    excerpt: string;
	    // Go type: time
	    deletedAt: any;
	    originalRel: string;
	    size: number;
	    notes: number;
	    files: number;
	
	    static createFrom(source: any = {}) {
	        return new TrashItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.kind = source["kind"];
	        this.title = source["title"];
	        this.folder = source["folder"];
	        this.excerpt = source["excerpt"];
	        this.deletedAt = this.convertValues(source["deletedAt"], null);
	        this.originalRel = source["originalRel"];
	        this.size = source["size"];
	        this.notes = source["notes"];
	        this.files = source["files"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

