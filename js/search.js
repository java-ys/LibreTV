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
        
        const requestStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const response = await fetch(PROXY_URL + encodeURIComponent(apiUrl), {
            headers: API_CONFIG.search.headers,
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            return [];
        }

        const responseEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const responseText = await response.text();

        let data;
        try {
            data = JSON.parse(responseText);
        } catch (parseError) {
            console.warn(`API ${apiId} 返回的搜索结果无法解析:`, parseError);
            return [];
        }

        const durationMs = responseEnd - requestStart;
        const durationSeconds = durationMs > 0 ? durationMs / 1000 : 0;
        let payloadSizeBytes = 0;
        try {
            payloadSizeBytes = new TextEncoder().encode(responseText).length;
        } catch (encoderError) {
            // TextEncoder 在极少数环境中不可用，回退到字符串长度估算
            payloadSizeBytes = responseText.length * 2;
        }
        const speedKbps = durationSeconds > 0
            ? Math.round((payloadSizeBytes / 1024) / durationSeconds)
            : null;
        const latencyMs = Math.round(durationMs);

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
            speedKbps
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
                        
                        const pageStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                        const pageResponse = await fetch(PROXY_URL + encodeURIComponent(pageUrl), {
                            headers: API_CONFIG.search.headers,
                            signal: pageController.signal
                        });

                        clearTimeout(pageTimeoutId);

                        if (!pageResponse.ok) return [];

                        const pageEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                        const pageText = await pageResponse.text();

                        let pageData;
                        try {
                            pageData = JSON.parse(pageText);
                        } catch (pageParseError) {
                            console.warn(`API ${apiId} 第${page}页返回数据解析失败:`, pageParseError);
                            return [];
                        }

                        const pageDurationMs = pageEnd - pageStart;
                        const pageDurationSeconds = pageDurationMs > 0 ? pageDurationMs / 1000 : 0;
                        let pageSizeBytes = 0;
                        try {
                            pageSizeBytes = new TextEncoder().encode(pageText).length;
                        } catch (encoderError) {
                            pageSizeBytes = pageText.length * 2;
                        }
                        const pageSpeedKbps = pageDurationSeconds > 0
                            ? Math.round((pageSizeBytes / 1024) / pageDurationSeconds)
                            : null;
                        const pageLatencyMs = Math.round(pageDurationMs);

                        if (!pageData || !pageData.list || !Array.isArray(pageData.list)) return [];

                        // 处理当前页结果
                        return pageData.list.map(item => ({
                            ...item,
                            source_name: apiName,
                            source_code: apiId,
                            api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined,
                            latencyMs: pageLatencyMs,
                            speedKbps: pageSpeedKbps
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