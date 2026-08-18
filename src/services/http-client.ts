import axios, { AxiosInstance, AxiosResponse, AxiosError, InternalAxiosRequestConfig } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { JenkinsClientConfig, WorkspaceFileInfo } from '../types';
import { Logger } from '../utils/logger';
import { getErrorMessage } from '../utils/helpers';
import { AuthenticationError, NetworkError, JenkinsError, JobNotFoundError } from '../errors';

/**
 * CrumbData 接口定义
 * 用于接收 Jenkins CSRF crumb 响应数据的结构
 * interface 是 TypeScript 中定义对象形状的方式，类似于其他语言的“结构体”或“类型定义”
 */
interface CrumbData {
  crumbRequestField: string;  // Jenkins 要求携带 crumb 的 HTTP header 名称
  crumb: string;              // 实际的 crumb 值
}

/**
 * HttpClient 类
 * 封装与 Jenkins 服务器的 HTTP 通信
 * 使用 axios 库（一个流行的 Node.js HTTP 客户端）来发送请求
 */
export class HttpClient {
  private axiosInstance: AxiosInstance;  // axios 实例，用于发送 HTTP 请求
  private config: JenkinsClientConfig;   // Jenkins 客户端配置
  private logger: Logger;                // 日志记录器
  private crumb: string | null = null;   // CSRF crumb 值，null 表示未获取或不启用
  private sessionCookie: string | null = null;  // Session cookie，从 crumbIssuer 响应中获取

  constructor(config: JenkinsClientConfig) {
    this.config = config;
    this.logger = new Logger(config.logLevel || 'info');

    const credential = this.getCredential(config);

    // axios.create() 创建一个预配置好的 axios 实例
    // 这样每次发送请求时都会自动带上这些配置，无需重复设置
    this.axiosInstance = axios.create({
      baseURL: config.url,          // 基础 URL，所有请求都会自动拼接这个前缀
      timeout: config.timeout || 30000,  // 请求超时时间（毫秒），默认 30 秒
      auth: {
        username: config.username,  // HTTP Basic Auth 用户名
        password: credential,       // HTTP Basic Auth 密码（可以是密码或 API Token）
      },
      headers: {
        'Content-Type': 'application/json',  // 默认请求体格式为 JSON
      },
    });

    // 注册请求拦截器
    // 拦截器（Interceptor）是 axios 提供的机制，可以在请求发出前和响应返回后执行自定义逻辑
    // 类似于“中间件”或“钩子函数”
    this.axiosInstance.interceptors.request.use(
      // 请求成功时的处理函数
      (config: InternalAxiosRequestConfig) => {
        this.logRequest(config);
        return config;  // 必须返回 config，否则请求会被阻断
      },
      // 请求失败时的处理函数
      (error: AxiosError) => {
        this.logger.error('请求配置错误:', error.message);
        return Promise.reject(error);  // Promise.reject() 表示将一个 Promise 标记为失败状态
      }
    );

    // 注册响应拦截器
    this.axiosInstance.interceptors.response.use(
      // 响应成功时的处理函数
      (response: AxiosResponse) => {
        this.logResponse(response);
        return response;  // 必须返回 response，否则调用方收不到响应
      },
      // 响应失败时的处理函数（如 4xx、5xx 状态码或网络错误）
      (error: AxiosError) => this.handleAxiosError(error)
    );
  }

  /**
   * 记录请求信息（在请求发出前调用）
   * @param config - axios 内部请求配置对象，包含 URL、方法、headers、请求体等信息
   */
  private logRequest(config: InternalAxiosRequestConfig): void {
    this.logger.debug('>>> 发送请求 >>>');
    this.logger.debug(`  方法: ${config.method?.toUpperCase() || 'UNKNOWN'}`);  // ?. 是可选链操作符，如果 config.method 为 null/undefined 则不会报错，直接返回 undefined
    this.logger.debug(`  URL: ${config.baseURL || ''}${config.url || ''}`);
    if (config.params) {
      // params 是 URL 查询参数，axios 会自动将其拼接到 URL 后面
      this.logger.debug(`  查询参数: ${JSON.stringify(config.params)}`);
    }
    if (config.data) {
      // data 是请求体（POST/PUT 等方法的载荷）
      this.logger.debug(`  请求体: ${typeof config.data === 'string' ? config.data : JSON.stringify(config.data)}`);
    }
    /**
     * Axios 处理请求的底层逻辑顺序是这样的：
     *  合并配置：将实例配置（你 create 时写的 auth）和请求配置合并。
     *  执行请求拦截器：也就是你写的 interceptors.request.use 中的代码。此时 auth 还只是一个普通的配置对象，还没有被转换成 Header。
     *  转换 Headers：Axios 内部执行 transformRequest，在这里它才会检查是否有 auth 属性，并将其转换为 Base64 编码，最终挂载到 config.headers.Authorization 上。
     *  发送网络请求：带着转换好的 Headers 真正发出请求。
     * 所以，当你在拦截器里打印 config.headers 时，转换还没发生，自然就没有 Authorization 这一项。
     */
    if (config.auth && !config.headers.Authorization) {
      const { username, password } = config.auth;
      const base64 = btoa(`${username}:${password}`);
      config.headers.Authorization = `Basic ${base64}`;
    }
    this.logger.debug(`  Headers: ${JSON.stringify(config.headers)}`);
  }

  /**
   * 记录响应信息（在响应返回后调用）
   * @param response - axios 响应对象，包含状态码、响应体、响应 headers 等信息
   */
  private logResponse(response: AxiosResponse): void {
    this.logger.debug('<<< 接收响应 <<<');
    this.logger.debug(`  状态码: ${response.status} ${response.statusText}`);
    this.logger.debug(`  URL: ${response.config.baseURL || ''}${response.config.url || ''}`);
    this.logger.debug(`  响应头: ${this.safeStringify(response.headers)}`);
    // 响应体可能是对象、字符串、流等，根据 responseType 不同而不同
    const body: unknown = response.data;
    if (body && typeof body === 'object' && typeof (body as { pipe?: unknown }).pipe === 'function') {
      // 流式响应，跳过序列化
      this.logger.debug('  响应体: [Stream]');
    } else if (typeof body === 'string') {
      this.logger.debug(`  响应体 (字符串, 长度: ${body.length})`);
      if (body.length <= 1000) {
        this.logger.debug(`  ${body}`);
      } else {
        this.logger.debug(`  ${body.substring(0, 500)}... (截断)`);
      }
    } else {
      this.logger.debug(`  响应体: ${this.safeStringify(body)}`);
    }
  }

  /**
   * 安全地将对象转换为 JSON 字符串，处理循环引用
   */
  private safeStringify(obj: unknown): string {
    const seen = new WeakSet<object>();
    return JSON.stringify(obj, (_key: string, value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    }, 2);
  }

  /**
   * 获取认证凭据 (优先使用 apiToken,其次使用 password)
   * private 表示这个方法只能在本类内部调用，外部无法访问
   * : string 表示返回值类型必须是字符串
   */
  private getCredential(config: JenkinsClientConfig): string {
    if (config.apiToken) {
      return config.apiToken;
    }
    if (config.password) {
      return config.password;
    }
    // throw new Error() 用于抛出异常，中断程序执行并向上层传递错误信息
    throw new Error('Either "apiToken" or "password" must be provided in JenkinsClientConfig');
  }

  /**
   * 获取 Jenkins 服务器的基础 URL
   * 没有 private 修饰，表示这是一个公共方法，可以被外部调用
   */
  getBaseUrl(): string {
    return this.config.url;
  }

  /**
   * 初始化 CSRF crumb (如果启用)
   * async 关键字表示这是一个异步函数，内部可以使用 await 等待 Promise 完成
   * Promise<void> 表示这个异步操作完成后不返回任何值（类似于其他语言的 void 或 None）
   */
  async initCrumb(): Promise<void> {
    try {
      // await 关键字会暂停当前函数的执行，等待 axiosInstance.get() 返回结果
      // axiosInstance.get() 发送 HTTP GET 请求，返回一个 Promise<AxiosResponse>
      // Promise 是 JavaScript/TypeScript 中表示异步操作结果的对象
      const response = await this.axiosInstance.get('/crumbIssuer/api/json');
      // as CrumbData 是 TypeScript 的类型断言，告诉编译器“我确定 response.data 符合 CrumbData 接口”
      // 类似于其他语言的强制类型转换
      const data = response.data as CrumbData;
      this.crumb = data.crumb;
      // 将 crumb 设置到 axios 实例的默认 headers 中，后续所有请求都会自动带上
      this.axiosInstance.defaults.headers[data.crumbRequestField] = this.crumb;
      
      // 提取 Set-Cookie 响应头中的 session cookie
      // Jenkins 要求在获取 crumb 时记录 session cookie，后续请求需同时携带 crumb 和 cookie
      const setCookie = response.headers['set-cookie'];
      if (setCookie) {
        // set-cookie 可能是字符串或字符串数组，统一处理
        this.sessionCookie = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
        // 将 cookie 设置到 axios 实例的默认 headers 中，后续所有请求都会自动带上
        this.axiosInstance.defaults.headers['Cookie'] = this.sessionCookie;
        this.logger.debug('Session cookie obtained from crumbIssuer response');
      }
      
      this.logger.debug('CSRF crumb obtained');
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        // 404 表示 Jenkins 服务器没有启用 CSRF 保护，这是正常情况
        this.logger.debug('CSRF protection not enabled on Jenkins server');
      } else {
        this.logger.warn('Failed to obtain CSRF crumb:', getErrorMessage(error));
      }
    }
  }

  /**
   * GET 请求方法
   * <T> 是 TypeScript 泛型，允许调用方指定期望的返回数据类型
   * 例如: client.get<UserInfo>('/user') 会返回 Promise<UserInfo>
   * params 后面的 ? 表示这个参数是可选的，调用时可以省略
   * Record<string, any> 是 TypeScript 内置类型，表示一个键为字符串、值为任意类型的对象
   */
  async get<T>(urlPath: string, params?: Record<string, unknown>): Promise<T> {
    const response: AxiosResponse<T> = await this.axiosInstance.get(urlPath, { params });
    return response.data;
  }

  /**
   * GET 请求方法（返回 data + 响应头）
   * 供需要读取响应头的场景使用，如 progressiveText 的 X-Text-Size
   */
  async getFull<T>(urlPath: string, params?: Record<string, unknown>): Promise<{ data: T; headers: Record<string, string> }> {
    const response: AxiosResponse<T> = await this.axiosInstance.get(urlPath, { params });
    return { data: response.data, headers: response.headers as Record<string, string> };
  }

  /**
   * POST 请求方法
   * 返回一个包含 data（响应体）和 headers（响应头）的对象
   */
  async post<T>(urlPath: string, data?: unknown, headers?: Record<string, string>): Promise<{ data: T; headers: Record<string, string> }> {
    const response: AxiosResponse<T> = await this.axiosInstance.post(urlPath, data, { headers });
    return { data: response.data, headers: response.headers as Record<string, string> };
  }

  /**
   * 下载文件（流式下载）
   * 流式下载适合大文件，数据边接收边写入磁盘，不需要等到全部下载完才写入
   * onProgress 是一个回调函数，调用方可以传入此函数来接收下载进度通知
   */
  async download(
    urlPath: string,
    outputPath: string,
    onProgress?: (progress: number, downloaded: number, total: number) => void
  ): Promise<void> {
    // responseType: 'stream' 告诉 axios 返回 Node.js 的 Readable Stream（可读流）
    // 流是一种逐步读取数据的方式，不需要一次性将所有数据加载到内存
    const response = await this.axiosInstance.get<Readable>(urlPath, {
      responseType: 'stream',
    });

    // parseInt(String(...), 10) 将 content-length header 转换为十进制整数
    // String() 用于确保值被转换为字符串，避免 parseInt 接收非字符串类型
    const totalBytes = parseInt(String(response.headers['content-length'] || '0'), 10);
    let downloadedBytes = 0;

    // new Promise((resolve, reject) => { ... }) 创建一个 Promise 对象
    // resolve 是成功时的回调，调用它表示 Promise 完成
    // reject 是失败时的回调，调用它表示 Promise 失败
    return new Promise((resolve, reject) => {
      // path.dirname() 从完整路径中提取目录部分
      // 例如: '/tmp/downloads/file.txt' => '/tmp/downloads'
      const dir = path.dirname(outputPath);
      // fs.existsSync() 检查目录是否存在
      if (!fs.existsSync(dir)) {
        // fs.mkdirSync() 创建目录，recursive: true 表示如果父目录也不存在则一并创建
        fs.mkdirSync(dir, { recursive: true });
      }

      // fs.createWriteStream() 创建一个写入流，用于将数据逐步写入文件
      const writer = fs.createWriteStream(outputPath);

      // response.data 是一个 Readable Stream（可读流）
      // .on('data', callback) 每当收到一块数据时，callback 会被调用
      response.data.on('data', (chunk: Buffer) => {
        // chunk 是 Buffer 类型，表示一块二进制数据
        // chunk.length 是这块数据的字节数
        downloadedBytes += chunk.length;
        if (onProgress && totalBytes > 0) {
          // 调用调用方传入的进度回调函数
          onProgress(downloadedBytes / totalBytes, downloadedBytes, totalBytes);
        }
      });

      // .pipe() 将可读流连接到可写流，数据会自动从 response.data 流向 writer
      response.data.pipe(writer);

      // 当写入流完成时，调用 resolve() 表示 Promise 成功
      writer.on('finish', () => resolve());
      // 当写入流出错时，调用 reject(err) 表示 Promise 失败
      writer.on('error', (err) => reject(err));
    });
  }

  /**
   * 处理 Axios 错误
   * : never 是 TypeScript 的特殊类型，表示这个函数永远不会正常返回（总是会抛出异常）
   */
  private handleAxiosError(error: AxiosError): never {
    // error.response 存在表示服务器返回了响应（但状态码是 4xx 或 5xx）
    if (error.response) {
      // 解构赋值：从 error.response 中提取 status 和 data
      const { status, data } = error.response;

      if (status === 401 || status === 403) {
        // 401 未授权，403 禁止访问，都是认证/授权相关错误
        throw new AuthenticationError(
          `Authentication failed (${status}). Please check your username and API token.`,
          status
        );
      }

      if (status === 404) {
        // 404 资源不存在
        const message = typeof data === 'string' ? data : 'Resource not found';
        if (message.includes('job') || message.includes('Job')) {
          throw new JobNotFoundError(message);
        }
        throw new JenkinsError(message, status);
      }

      // 其他服务器错误（5xx 等）
      throw new JenkinsError(
        `Request failed with status ${status}: ${error.message}`,
        status
      );
    }

    // error.code 存在表示请求根本没有到达服务器（网络层面的错误）
    if (error.code === 'ECONNABORTED') {
      throw new NetworkError(`Request timed out after ${this.config.timeout || 30000}ms`);
    }

    // 其他网络错误（DNS 解析失败、连接被拒绝等）
    throw new NetworkError(`Network error: ${error.message}`);
  }

  /**
   * 获取 workspace 文件列表
   * Jenkins workspace 浏览 API 返回 HTML 格式的文件列表，需要解析
   * @param jobName - Job 名称（支持多级路径，如 'server/job/pex/job/pty-pcx'）
   * @param buildNumber - 构建编号（可选，不传则访问当前 workspace）
   * @param workspacePath - workspace 内的相对路径（可选）
   */
  async getWorkspaceFileList(
    jobName: string,
    buildNumber?: number,
    workspacePath?: string
  ): Promise<WorkspaceFileInfo[]> {
    const buildSegment = buildNumber ? `/${buildNumber}` : '';
    const url = `/job/${jobName}${buildSegment}/ws/${workspacePath || ''}`;
    this.logger.debug(`Fetching workspace file list: ${url}`);

    // 获取 HTML 格式的文件列表
    const html = await this.axiosInstance.get<string>(url, {
      headers: { 'Accept': 'text/html' },
      responseType: 'text',
    });

    return this.parseWorkspaceHtml(html.data, workspacePath || '');
  }

  /**
   * 解析 Jenkins workspace HTML 文件列表
   * Jenkins 返回的 HTML 格式为：
   * <tr><td><a href="...">文件名</a></td><td>大小</td><td>日期</td></tr>
   */
  private parseWorkspaceHtml(html: string, basePath: string): WorkspaceFileInfo[] {
    const files: WorkspaceFileInfo[] = [];
    
    // 匹配 <a href="...">文件名</a> 标签
    // Jenkins workspace HTML 中，文件链接格式为: <a href="filename/"> 或 <a href="filename">
    const linkRegex = /<a href="([^"]+)">([^<]+)<\/a>/g;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const name = match[2];

      // 跳过父目录链接 (..)
      if (name === '..' || name === 'Parent Directory') {
        continue;
      }

      // 判断是否为目录（href 以 / 结尾）
      const isDirectory = href.endsWith('/');
      const relativePath = basePath ? `${basePath}/${name}` : name;

      files.push({
        name,
        relativePath,
        isDirectory,
      });
    }

    return files;
  }
}
