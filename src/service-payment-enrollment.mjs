import { OrganizationClient, usdNanodollars } from "@alderinc/sdk";

import { alderMcpUrl, alderServicesUrl, alderUrl } from "./endpoints.mjs";
import { decryptEnrollment, requestJson, required } from "./shared.mjs";

function initialManagedSessionPayment() {
  const amount = required("PROVIBOT_INITIAL_MANAGED_SESSION_NANODOLLARS");
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    throw new Error("PROVIBOT_INITIAL_MANAGED_SESSION_NANODOLLARS must be a positive integer nanodollar amount");
  }
  return {
    amountUsd: usdNanodollars(BigInt(amount)),
    merchantApplicationId: required("ALDER_SERVICES_MERCHANT_APPLICATION_ID"),
  };
}

function ownerOrganization() {
  return new OrganizationClient({
    alderUrl,
    orgApiKey: required("ALDER_ORG_API_KEY"),
  });
}

/**
 * The owner creates an enrollment and Alder places any establish grant only in
 * its encrypted bundle.  This launcher never writes an apg_ to disk or state.
 */
export async function ownerServiceEnrollment({ agentId, establish, installationId }) {
  const enrollment = await ownerOrganization().createRuntimeEnrollment({
    agentId,
    accessTokenTtlSeconds: 900,
    alderMcpUrl,
    expiresInSeconds: 300,
    ...(establish ? { initialServicePayment: initialManagedSessionPayment() } : {}),
    requiredServices: [],
    runtime: "managed-session",
  });
  const exchanged = await requestJson(`${alderUrl}/runtime-enrollments/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollmentId: enrollment.enrollmentId, enrollmentSecret: enrollment.enrollmentSecret, installationId }),
  }, "runtime enrollment exchange");
  const bundle = decryptEnrollment(enrollment.enrollmentSecret, installationId, exchanged.encryptedBundle);
  const credentials = bundle.credentials?.alderMcp;
  if (!credentials?.accessToken || !credentials?.refreshToken) {
    throw new Error("runtime enrollment did not contain renewable Alder control credentials");
  }
  const establishment = bundle.initialServicePayment;
  if (establish && (!establishment?.grant || establishment.merchantApplicationId !== process.env.ALDER_SERVICES_MERCHANT_APPLICATION_ID?.trim())) {
    throw new Error("owner enrollment did not contain the encrypted managed-session establishment grant");
  }
  return {
    acknowledge: async () => requestJson(`${alderUrl}/runtime-enrollments/${encodeURIComponent(enrollment.enrollmentId)}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollmentId: enrollment.enrollmentId, enrollmentSecret: enrollment.enrollmentSecret, installationId }),
    }, "runtime enrollment acknowledgment"),
    controlCredentials: credentials,
    establishmentGrant: establishment?.grant ?? null,
  };
}

export { alderServicesUrl };
