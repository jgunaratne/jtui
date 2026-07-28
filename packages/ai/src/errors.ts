import type { VertexCredentials } from "./auth.ts";

/**
 * Turn a Vertex failure into a message that says what to do about it.
 *
 * Model Garden lists every model Google publishes, but a project can only call
 * the ones it has been granted, so "not found" is usually an access problem
 * rather than a typo — the message says so.
 */
export function formatVertexError(error: unknown, credentials: VertexCredentials, model?: string): string {
	const raw = error instanceof Error ? error.message : String(error);
	const { project, location } = credentials;
	const target = model ? `"${model}"` : "that model";

	if (/403|PERMISSION_DENIED/.test(raw)) {
		return `${raw}\n\nThe credentials lack Vertex AI access on project "${project}". Grant the "Vertex AI User" role, or run: gcloud services enable aiplatform.googleapis.com --project ${project}`;
	}
	if (/404|NOT_FOUND/.test(raw)) {
		return `${raw}\n\nProject "${project}" cannot call ${target} in "${location}". Being listed by "jtui models" only means the model exists — access is granted separately. Enable it in Vertex AI Model Garden, or try another --location (models are region-specific; "global" often has the widest coverage).`;
	}
	if (/429|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(raw)) {
		return `${raw}\n\nVertex AI quota exhausted for project "${project}" in "${location}". Request more quota, or switch model or location.`;
	}
	if (/401|UNAUTHENTICATED/.test(raw)) {
		return `${raw}\n\nCredentials were rejected. Run: gcloud auth application-default login`;
	}
	return raw;
}
