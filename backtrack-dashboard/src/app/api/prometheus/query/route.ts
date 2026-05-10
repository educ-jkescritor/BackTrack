import { NextRequest, NextResponse } from "next/server";
import { getConnection } from "@/lib/monitoring-store";

export async function GET(request: NextRequest) {
	const { searchParams } = new URL(request.url);
	const connectionId = searchParams.get("connectionId");
	const query = searchParams.get("query");

	if (!connectionId || !query) {
		return NextResponse.json(
			{ error: "connectionId and query are required." },
			{ status: 400 },
		);
	}

	const connection = getConnection(connectionId);

	if (!connection) {
		return NextResponse.json({ error: "Connection not found." }, { status: 404 });
	}

	try {
		const url = new URL("/api/v1/query", connection.prometheusUrl);
		url.searchParams.set("query", query);

		const response = await fetch(url, {
			headers: connection.authToken
				? { Authorization: `Bearer ${connection.authToken}` }
				: undefined,
			cache: "no-store",
		});

		const data = await response.json();

		return NextResponse.json({
			connectionId: connection.id,
			status: response.ok ? "success" : "error",
			upstreamStatus: response.status,
			queriedUrl: `${url.origin}${url.pathname}`,
			data,
		});
	} catch (error: unknown) {
		return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
	}
}
