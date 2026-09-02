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

function ownerInitialGrantCapNanodollars() {
  return assertPositiveNanodollars(
    required("PROVIBOT_INITIAL_SERVICE_GRANT_CAP_NANODOLLARS"),
    "PROVIBOT_INITIAL_SERVICE_GRANT_CAP_NANODOLLARS",
  );
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
    runtime: "managed-session",
  });
  return exchangeOwnerEnrollment(enrollment, installationId);
}

/**
 * The owner establishes the first relationship in one encrypted enrollment.
 * A conservative owner-selected cap bounds the one-use grant. Services
 * derives the live quote and redeems that same grant into the first hold and
 * pma_ in one operation. The launcher never writes an apg_ to disk or state.
 */
export async function ownerServiceEnrollment({ agentId, establish, installationId }) {
  if (!establish) return createOwnerEnrollment({ agentId, installationId });

  const established = await createOwnerEnrollment({
    agentId,
    installationId,
    paymentGrantCapNanodollars: ownerInitialGrantCapNanodollars(),
  });
  const establishment = established.bundle.initialServicePayment;
  if (establish && (!establishment?.grant || establishment.merchantApplicationId !== process.env.ALDER_SERVICES_MERCHANT_APPLICATION_ID?.trim())) {
    throw new Error("owner enrollment did not contain the encrypted managed-session establishment grant");
  }
  const connected = await requestJson(`${alderServicesUrl}/connections`, {
    body: JSON.stringify({ mode: "managed_session" }),
    headers: {
      "content-type": "application/json",
      "idempotency-key": `provibot:${agentId}:services-establish:v1`,
      "x-alder-payment-grant": establishment.grant,
    },
    method: "POST",
  }, "establish Alder Services connection");
  if (typeof connected?.connection?.pmaRef !== "string" || !connected.connection.pmaRef.startsWith("pma_")) {
    throw new Error("Alder Services did not establish a durable payment relationship");
  }
  const quote = connected?.initialAdmission?.quote;
  if (typeof quote?.paymentGrantCapNanodollars !== "string" || BigInt(quote.paymentGrantCapNanodollars) > BigInt(ownerInitialGrantCapNanodollars())) {
    throw new Error("Alder Services initial admission exceeds the owner-selected establishment grant cap");
  }
  return {
    acknowledge: established.acknowledge,
    controlCredentials: established.controlCredentials,
    pmaRef: connected.connection.pmaRef,
  };
}

/**
 * A replacement hosted session needs a normal Services credential to admit
 * work against an already-established relationship. The local launcher uses
 * its short-lived Alder control credential only to obtain the one-use recovery
 * proof; the resulting sat_ is deliberately ephemeral and is never written to
 * local state. Once the session is live, the agent performs the same recovery
 * itself and persists its own sat_ in its sandbox.
 */
export async function findExistingServicesConnection(controlCredentials) {
  if (!controlCredentials?.accessToken) {
    throw new Error("Alder control credential is required to read an existing Services connection");
  }
  const connections = await requestJson(`${alderUrl}/agent/merchant-connections`, {
    headers: { authorization: `Bearer ${controlCredentials.accessToken}` },
    method: "GET",
  }, "read existing Alder Services connection");
  const merchantApplicationId = required("ALDER_SERVICES_MERCHANT_APPLICATION_ID");
  const connection = Array.isArray(connections?.items)
    ? connections.items.find((item) => item?.merchantApplicationId === merchantApplicationId && item?.status === "active") ?? null
    : null;
  return connection?.pmaRef ? { pmaRef: connection.pmaRef } : null;
}

export async function recoverExistingServicesAccess(controlCredentials, knownConnection = null, profile = "agent") {
  if (!controlCredentials?.accessToken) {
    throw new Error("Alder control credential is required to recover an existing Services connection");
  }
  const connection = knownConnection ?? await findExistingServicesConnection(controlCredentials);
  if (!connection?.pmaRef) return null;

  const proof = await requestJson(`${alderUrl}/agent/merchant-connections/${encodeURIComponent(connection.pmaRef)}/recovery-proofs`, {
    headers: {
      authorization: `Bearer ${controlCredentials.accessToken}`,
      "content-type": "application/json",
    },
    method: "POST",
  }, "create Alder Services recovery proof");
  if (typeof proof?.proof !== "string" || !proof.proof.startsWith("prp_")) {
    throw new Error("Alder did not return a valid one-use Services recovery proof");
  }
  const recovered = await requestJson(`${alderServicesUrl}/connections/recover`, {
    body: JSON.stringify({ pmaRef: connection.pmaRef, profile }),
    headers: {
      "content-type": "application/json",
      "x-alder-connection-recovery-proof": proof.proof,
    },
    method: "POST",
  }, "recover Alder Services access");
  if (typeof recovered?.sat !== "string" || !recovered.sat.startsWith("sat_")) {
    throw new Error("Alder Services did not return a valid recovered access token");
  }
  return { expiresAt: recovered.expiresAt, pmaRef: connection.pmaRef, sat: recovered.sat };
}

export { alderServicesUrl };
