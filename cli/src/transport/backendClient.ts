export const backendClient = {
    async post(path: string, body: any) {
        const res = await fetch(`http://localhost:3000${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })

        return res.json()
    }
}
