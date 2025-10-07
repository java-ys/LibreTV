const getTimestamp = () => (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

const computeNetworkMetrics = (requestUrl, requestStart, headersReceived, requestEnd, response, responseText) => {
    const fallbackLatency = Math.max(0, Math.round(headersReceived - requestStart));
    const fallbackDownloadSeconds = Math.max((requestEnd - headersReceived) / 1000, 0);
    const fallbackTotalSeconds = Math.max((requestEnd - requestStart) / 1000, 0);

    let headerSize = 0;
    if (response && typeof response.headers?.get === 'function') {
        const lengthHeader = Number(response.headers.get('content-length'));
        if (!Number.isNaN(lengthHeader) && lengthHeader > 0) {
            headerSize = lengthHeader;
        }
    }

    let encodedSize = 0;
    if (responseText) {
        try {
            encodedSize = new TextEncoder().encode(responseText).length;
        } catch (encoderError) {
            encodedSize = responseText.length * 2;
        }
    }

    let latencyMs = fallbackLatency;
    let downloadSeconds = fallbackDownloadSeconds;
    let totalSeconds = fallbackTotalSeconds;
    let payloadSizeBytes = headerSize || encodedSize;

    const hasPerformanceNow = typeof performance !== 'undefined' && typeof performance.now === 'function';
    if (typeof performance !== 'undefined' && typeof performance.getEntriesByName === 'function') {
        const entries = performance.getEntriesByName(requestUrl) || [];
        if (entries.length) {
            const threshold = hasPerformanceNow && typeof requestStart === 'number'
                ? requestStart - 5
                : null;
            let candidate = null;
            for (const entry of entries) {
                if (threshold !== null && typeof entry.startTime === 'number' && entry.startTime + 0.01 < threshold) {
                    continue;
                }
                if (!candidate || (entry.responseEnd || 0) > (candidate.responseEnd || 0)) {
                    candidate = entry;
                }
            }
            if (!candidate) {
                candidate = entries[entries.length - 1];
            }
            if (candidate) {
                const entryLatency = (candidate.responseStart || 0) - (candidate.startTime || 0);
                if (Number.isFinite(entryLatency) && entryLatency >= 0) {
                    latencyMs = Math.max(0, Math.round(entryLatency));
                }
                const entryDownload = (candidate.responseEnd || 0) - (candidate.responseStart || 0);
                if (Number.isFinite(entryDownload) && entryDownload > 0) {
                    downloadSeconds = Math.max(entryDownload / 1000, downloadSeconds);
                }
                const entryTotal = (candidate.responseEnd || 0) - (candidate.startTime || 0);
                if (Number.isFinite(entryTotal) && entryTotal > 0) {
                    totalSeconds = Math.max(entryTotal / 1000, totalSeconds);
                }
                const entrySize = candidate.transferSize && candidate.transferSize > 0
                    ? candidate.transferSize
                    : candidate.encodedBodySize && candidate.encodedBodySize > 0
                        ? candidate.encodedBodySize
                        : candidate.decodedBodySize && candidate.decodedBodySize > 0
                            ? candidate.decodedBodySize
                            : 0;
                if (entrySize > 0) {
                    payloadSizeBytes = entrySize;
                }
            }
        }
    }

    if (!payloadSizeBytes) {
        payloadSizeBytes = encodedSize || headerSize;
    }

    if (downloadSeconds <= 0) {
        downloadSeconds = totalSeconds - (latencyMs / 1000);
    }
    if (downloadSeconds <= 0) {
        downloadSeconds = totalSeconds;
    }

    const effectiveSeconds = Math.max(downloadSeconds, 0.01);
    const speedKBps = payloadSizeBytes > 0
        ? (payloadSizeBytes / 1024) / effectiveSeconds
        : null;

    return {
        latencyMs,
        speedKBps: Number.isFinite(speedKBps) && speedKBps > 0 ? speedKBps : null
    };
};

async function searchByAPIAndKeyWord(apiId, query) {
    try {
        let apiUrl, apiName, apiBaseUrl;
        
        // 处理自定义API
        if (apiId.startsWith('custom_')) {
            const customIndex = apiId.replace('custom_', '');
            const customApi = getCustomApiInfo(customIndex);
            if (!customApi) return [];
            
            apiBaseUrl = customApi.url;
            apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
            apiName = customApi.name;
        } else {
            // 内置API
            if (!API_SITES[apiId]) return [];
            apiBaseUrl = API_SITES[apiId].api;
            apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
            apiName = API_SITES[apiId].name;
        }
        
        // 添加超时处理
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        const requestUrl = PROXY_URL + encodeURIComponent(apiUrl);
        const requestStart = getTimestamp();
        const response = await fetch(requestUrl, {
            headers: API_CONFIG.search.headers,
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            return [];
        }

        const headersReceived = getTimestamp();
        const responseText = await response.text();
        const requestEnd = getTimestamp();

        let data;
        try {
            data = JSON.parse(responseText);
        } catch (parseError) {
            console.warn(`API ${apiId} 返回的搜索结果无法解析:`, parseError);
            return [];
        }

        const { latencyMs, speedKBps } = computeNetworkMetrics(
            requestUrl,
            requestStart,
            headersReceived,
            requestEnd,
            response,
            responseText
        );

        if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
            return [];
        }

        // 处理第一页结果
        const results = data.list.map(item => ({
            ...item,
            source_name: apiName,
            source_code: apiId,
            api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined,
            latencyMs,
            speedKBps
        }));
        
        // 获取总页数
        const pageCount = data.pagecount || 1;
        // 确定需要获取的额外页数 (最多获取maxPages页)
        const pagesToFetch = Math.min(pageCount - 1, API_CONFIG.search.maxPages - 1);
        
        // 如果有额外页数，获取更多页的结果
        if (pagesToFetch > 0) {
            const additionalPagePromises = [];
            
            for (let page = 2; page <= pagesToFetch + 1; page++) {
                // 构建分页URL
                const pageUrl = apiBaseUrl + API_CONFIG.search.pagePath
                    .replace('{query}', encodeURIComponent(query))
                    .replace('{page}', page);
                
                // 创建获取额外页的Promise
                const pagePromise = (async () => {
                    try {
                        const pageController = new AbortController();
                        const pageTimeoutId = setTimeout(() => pageController.abort(), 8000);
                        
                        const pageStart = getTimestamp();
                        const pageRequestUrl = PROXY_URL + encodeURIComponent(pageUrl);
                        const pageResponse = await fetch(pageRequestUrl, {
                            headers: API_CONFIG.search.headers,
                            signal: pageController.signal
                        });

                        clearTimeout(pageTimeoutId);

                        if (!pageResponse.ok) return [];

                        const pageHeadersReceived = getTimestamp();
                        const pageText = await pageResponse.text();
                        const pageEnd = getTimestamp();

                        let pageData;
                        try {
                            pageData = JSON.parse(pageText);
                        } catch (pageParseError) {
                            console.warn(`API ${apiId} 第${page}页返回数据解析失败:`, pageParseError);
                            return [];
                        }

                        const { latencyMs: pageLatencyMs, speedKBps: pageSpeedKBps } = computeNetworkMetrics(
                            pageRequestUrl,
                            pageStart,
                            pageHeadersReceived,
                            pageEnd,
                            pageResponse,
                            pageText
                        );

                        if (!pageData || !pageData.list || !Array.isArray(pageData.list)) return [];

                        // 处理当前页结果
                        return pageData.list.map(item => ({
                            ...item,
                            source_name: apiName,
                            source_code: apiId,
                            api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined,
                            latencyMs: pageLatencyMs,
                            speedKBps: pageSpeedKBps
                        }));
                    } catch (error) {
                        console.warn(`API ${apiId} 第${page}页搜索失败:`, error);
                        return [];
                    }
                })();
                
                additionalPagePromises.push(pagePromise);
            }
            
            // 等待所有额外页的结果
            const additionalResults = await Promise.all(additionalPagePromises);
            
            // 合并所有页的结果
            additionalResults.forEach(pageResults => {
                if (pageResults.length > 0) {
                    results.push(...pageResults);
                }
            });
        }
        
        return results;
    } catch (error) {
        console.warn(`API ${apiId} 搜索失败:`, error);
        return [];
    }
}