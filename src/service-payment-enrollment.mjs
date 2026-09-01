import { OrganizationClient, usdNanodollars } from "@alderinc/sdk";

import { alderMcpUrl, alderServicesUrl, alderUrl } from "./endpoints.mjs";
import { decryptEnrollment, requestJson, required } from "./shared.mjs";

function ownerOrganization() {
  return new OrganizationClient({
    alderUrl,
    orgApiKey: required("ALDER_ORG_API_KEY"),
  });
}

function assertPositiveNanodollars(value, field) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`Alder Services admission quote returned an invalid ${field}`);
  }
  return value;
}

async function exchangeOwnerEnrollment(enrollment, installationId) {
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
  return {
    acknowledge: () => requestJson(`${alderUrl}/runtime-enrollments/${encodeURIComponent(enrollment.enrollmentId)}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollmentId: enrollment.enrollmentId, enrollmentSecret: enrollment.enrollmentSecret, installationId }),
    }, "runtime enrollment acknowledgment"),
    bundle,
    controlCredentials: credentials,
  };
}

async function quoteManagedSessionAdmission(agentAccessToken) {
  const quote = await requestJson(`${alderServicesUrl}/agent-instances/admission-quote`, {
    headers: { authorization: `Bearer ${agentAccessToken}` },
  }, "managed-session admission quote");
  if (quote?.route !== "anthropic.managed.sessions" || typeof quote?.rateCardVersion !== "string") {
    throw new Error("Alder Services admission quote did not identify the managed-session rate card");
  }
  const engagementWindowNanodollars = assertPositiveNanodollars(quote.engagementWindowNanodollars, "engagementWindowNanodollars");
  const settlementReserveNanodollars = assertPositiveNanodollars(quote.settlementReserveNanodollars, "settlementReserveNanodollars");
  const paymentGrantCapNanodollars = assertPositiveNanodollars(quote.paymentGrantCapNanodollars, "paymentGrantCapNanodollars");
  if (BigInt(paymentGrantCapNanodollars) !== BigInt(engagementWindowNanodollars) + BigInt(settlementReserveNanodollars)) {
    throw new Error("Alder Services admission quote does not cover the complete first required hold");
  }
  return { paymentGrantCapNanodollars };
}

async function createOwnerEnrollment({ agentId, installationId, paymentGrantCapNanodollars = null }) {
  const enrollment = await ownerOrganization().createRuntimeEnrollment({
    agentId,
    accessTokenTtlSeconds: 900,
    alderMcpUrl,
    expiresInSeconds: 300,
    ...(paymentGrantCapNanodollars ? {
      initialServicePayment: {
        amountUsd: usdNanodollars(BigInt(paymentGrantCapNanodollars)),
        merchantApplicationId: required("ALDER_SERVICES_MERCHANT_APPLICATION_ID"),
      },
    } : {}),
    requiredServices: [],
    runtime: "managed-session",
  });
  return exchangeOwnerEnrollment(enrollment, installationId);
}

/**
 * The owner establishes the first relationship in one encrypted enrollment.
 * Services first quotes the actual server-side hold from its live rate card using a
 * disposable ordinary enrollment. This launcher never writes an apg_ to disk
 * or state and never reproduces the settlement-reserve arithmetic locally.
 */
export async function ownerServiceEnrollment({ agentId, establish, installationId }) {
  if (!establish) return createOwnerEnrollment({ agentId, installationId });

  const preflight = await createOwnerEnrollment({
    agentId,
    installationId: `${installationId}-admission-quote`,
  });
  let quote;
  try {
    quote = await quoteManagedSessionAdmission(preflight.controlCredentials.accessToken);
  } finally {
    await preflight.acknowledge();
  }

  const established = await createOwnerEnrollment({
    agentId,
    installationId,
    paymentGrantCapNanodollars: quote.paymentGrantCapNanodollars,
  });
  const establishment = established.bundle.initialServicePayment;
  if (establish && (!establishment?.grant || establishment.merchantApplicationId !== process.env.ALDER_SERVICES_MERCHANT_APPLICATION_ID?.trim())) {
    throw new Error("owner enrollment did not contain the encrypted managed-session establishment grant");
  }
  return {
    acknowledge: established.acknowledge,
    controlCredentials: established.controlCredentials,
    establishmentGrant: establishment?.grant ?? null,
  };
}

export { alderServicesUrl };
