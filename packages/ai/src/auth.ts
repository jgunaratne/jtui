import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GoogleAuth } from "google-auth-library";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_LOCATION = "us-central1";

/** Resolved Google Cloud credentials and target project. */
export interface VertexCredentials {
	project: string;
	location: string;
	/** Where the project id came from, for display in diagnostics. */
	projectSource: string;
	/** Where the credentials came from, for display in diagnostics. */
	credentialSource: string;
}

/** Explicit overrides, normally from the CLI or config file. */
export interface CredentialOverrides {
	project?: string;
	location?: string;
	/** Path to a service account key file. */
	credentialsFile?: string;
}

/** Default path written by `gcloud auth application-default login`. */
export function adcPath(): string {
	if (process.platform === "win32") {
		const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
		return join(appData, "gcloud", "application_default_credentials.json");
	}
	return join(homedir(), ".config", "gcloud", "application_default_credentials.json");
}

/** Error carrying actionable setup instructions. */
export class VertexAuthError extends Error {
	readonly hints: string[];

	constructor(message: string, hints: string[] = []) {
		super(message);
		this.name = "VertexAuthError";
		this.hints = hints;
	}
}

function resolveLocation(overrides: CredentialOverrides): { location: string } {
	const location =
		overrides.location ??
		process.env.GOOGLE_CLOUD_LOCATION ??
		process.env.GOOGLE_CLOUD_REGION ??
		process.env.VERTEX_LOCATION ??
		DEFAULT_LOCATION;
	return { location };
}

/**
 * Resolve Application Default Credentials and the target project.
 *
 * Order of preference for credentials: an explicit key file, then
 * `GOOGLE_APPLICATION_CREDENTIALS`, then the gcloud ADC file, then the
 * metadata server on GCE/Cloud Run.
 */
export async function resolveCredentials(overrides: CredentialOverrides = {}): Promise<VertexCredentials> {
	const keyFile = overrides.credentialsFile ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
	if (keyFile && !existsSync(keyFile)) {
		throw new VertexAuthError(`Service account key file not found: ${keyFile}`, [
			"Check the path, or unset GOOGLE_APPLICATION_CREDENTIALS to fall back to gcloud credentials.",
		]);
	}

	const auth = new GoogleAuth({
		scopes: [CLOUD_PLATFORM_SCOPE],
		...(keyFile ? { keyFile } : {}),
	});

	try {
		// Fails fast when no credential source is available at all.
		await auth.getClient();
	} catch (error) {
		throw new VertexAuthError(`Could not load Google Cloud credentials: ${describeError(error)}`, [
			"Run: gcloud auth application-default login",
			"Or set GOOGLE_APPLICATION_CREDENTIALS to a service account key file.",
		]);
	}

	let project = overrides.project ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
	let projectSource = overrides.project ? "--project" : "GOOGLE_CLOUD_PROJECT";
	if (!project) {
		project = (await auth.getProjectId().catch(() => undefined)) ?? undefined;
		projectSource = keyFile ? "service account key" : "application default credentials";
	}
	if (!project) {
		// User ADC files carry the project as quota_project_id rather than project_id,
		// which getProjectId() does not consult.
		project = readAdcQuotaProject(keyFile ?? adcPath());
		projectSource = "application default credentials (quota project)";
	}
	if (!project) {
		project = readGcloudConfigProject();
		projectSource = "gcloud config";
	}
	if (!project) {
		throw new VertexAuthError("No Google Cloud project configured.", [
			"Run: gcloud config set project YOUR_PROJECT_ID",
			"Or set GOOGLE_CLOUD_PROJECT, or pass --project.",
		]);
	}

	const credentialSource = keyFile
		? `service account key (${keyFile})`
		: existsSync(adcPath())
			? "gcloud application default credentials"
			: "ambient credentials (metadata server)";

	return { project, projectSource, credentialSource, ...resolveLocation(overrides) };
}

/**
 * Verify the credentials can actually mint a token. Called before the first
 * request so failures surface as setup errors rather than stream errors.
 */
export async function verifyCredentials(overrides: CredentialOverrides = {}): Promise<VertexCredentials> {
	const credentials = await resolveCredentials(overrides);
	const auth = new GoogleAuth({
		scopes: [CLOUD_PLATFORM_SCOPE],
		...(overrides.credentialsFile ? { keyFile: overrides.credentialsFile } : {}),
	});
	try {
		const client = await auth.getClient();
		const token = await client.getAccessToken();
		if (!token.token) throw new Error("no access token returned");
	} catch (error) {
		throw new VertexAuthError(`Google Cloud credentials are not usable: ${describeError(error)}`, [
			"Run: gcloud auth application-default login",
			`Confirm the Vertex AI API is enabled: gcloud services enable aiplatform.googleapis.com --project ${credentials.project}`,
		]);
	}
	return credentials;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read `quota_project_id` (or `project_id`) out of a credentials JSON file. */
function readAdcQuotaProject(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { quota_project_id?: string; project_id?: string };
		return parsed.quota_project_id ?? parsed.project_id;
	} catch {
		return undefined;
	}
}

/** Path to the active gcloud configuration file. */
function gcloudConfigPath(): string {
	const base =
		process.platform === "win32"
			? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "gcloud")
			: join(homedir(), ".config", "gcloud");
	const activeConfigPath = join(base, "active_config");
	const active = existsSync(activeConfigPath) ? readFileSync(activeConfigPath, "utf8").trim() : "default";
	return join(base, "configurations", `config_${active || "default"}`);
}

/** Parse `project = ...` out of the gcloud INI config. */
function readGcloudConfigProject(): string | undefined {
	const path = gcloudConfigPath();
	if (!existsSync(path)) return undefined;
	try {
		const match = /^\s*project\s*=\s*(.+)$/m.exec(readFileSync(path, "utf8"));
		return match?.[1]?.trim() || undefined;
	} catch {
		return undefined;
	}
}
