import { filter } from './Filter'
import { store } from './Store'
import { FileResult, ResultMeta } from './StoreType'
import {
  ServiceProvider,
  VideoProvider,
  PostBody,
  ImageData,
  FileData,
} from './CrawlResult'
import { settings } from './setting/Settings'
import { log } from './Log'
import { lang } from './Lang'

type Dict = {
  [key in ServiceProvider]: string
}

type EmbedDataArr = [ServiceProvider | VideoProvider, string][]

class SaveData {
  // 嵌入的文件只支持指定的网站，每个网站有固定的前缀
  private readonly providerDict: Dict = {
    youtube: 'https://www.youtube.com/watch?v=',
    fanbox: 'https://www.fanbox.cc/',
    gist: 'https://gist.github.com/',
    soundcloud: 'https://soundcloud.com/',
    vimeo: 'https://vimeo.com/',
    twitter: 'https://twitter.com/i/web/status/',
    google_forms: 'https://docs.google.com/forms/d/e/',
  }

  private readonly extractTextReg = new RegExp(/<[^<>]+>/g)

  protected readonly matchImgSrc = new RegExp(
    /(?<=src=")https.*?(jpeg|jpg|png|gif|bmp)/g
  )

  public receive(data: PostBody) {
    this.parsePost(data)
  }

  private parsePost(data: PostBody) {
    // 针对投稿进行检查，决定是否保留它
    const id = data.id
    const fee = data.feeRequired
    const date = data.publishedDatetime
    const title = data.title
    const check = filter.check({ id, fee, date, title })
    if (!check) {
      return
    }

    // 如果投稿检查通过，保存投稿信息
    const result: ResultMeta = {
      postId: data.id,
      type: data.type,
      title: data.title,
      date,
      fee,
      user: data.user.name,
      uid: data.user.userId,
      createID: data.creatorId,
      tags: data.tags.join(','),
      files: [],
      links: {
        fileId: '',
        name: 'links-' + data.id,
        ext: 'txt',
        size: null,
        index: 0,
        text: [],
        url: '',
        retryUrl: null,
      },
    }

    // 提取它的资源文件，并对每个资源进行检查，决定是否保存

    let index = 0 // 资源的序号
    // 封面图和文本资源的序号是 0，其他文件的序号自增

    // 提取投稿的封面图片
    // 封面图片的序号设置为 0，所以它里面不需要对 index 进行操作
    if (settings.savePostCover) {
      const cover = data.coverImageUrl
      if (cover) {
        const { name, ext } = this.getUrlNameAndExt(cover)
        const r: FileResult = {
          fileId: this.createFileId(),
          name,
          ext,
          size: null,
          index,
          url: cover,
          retryUrl: null,
        }
        result.files.push(r)
      }
    }

    // 对于因为价格限制不能抓取文章，在此时返回，但是会保存封面图
    if (data.body === null) {
      store.skipDueToFee++
      log.warning(
        lang.transl('_跳过文章因为', title) + lang.transl('_价格限制')
      )
      if (result.files.length > 0) {
        store.addResult(result)
      }
      return
    }

    // 非 article 投稿都有 text 字段，这这里统一提取里面的链接
    // 但是因为正则没有分组，所以非 article 投稿中如果有多个链接，可能会有遗漏，待考
    // 提取文本中的链接有两种来源，一种是文章正文里的文本，一种是嵌入资源。先从正文提取链接，后提取嵌入资源的链接。这样链接保存下来的顺序比较合理。
    if (data.type !== 'article') {
      let text = ''
      if (data.type === 'entry') {
        text = data.body.html.replace(this.extractTextReg, '')
      } else {
        text = data.body.text
      }
      if (text) {
        const links = this.getTextLinks(text)
        result.links.text = result.links.text.concat(links)
        result.links.fileId = this.createFileId()

        // 保存文章正文里的文字
        if (settings.saveText) {
          result.links.text.push(text)
        }
      }
    }

    // 提取 article 投稿的资源
    if (data.type === 'article') {
      // 从正文文本里提取链接
      let linkTexts: string[] = []
      let text = '' // 正文文本
      for (const block of data.body.blocks) {
        if (block.type === 'p' && block.text) {
          linkTexts.push(block.text)
          if (block.links && block.links.length > 0) {
            for (const links of block.links) {
              linkTexts.push(links.url)
            }
          }

          // 保存文章正文里的文字，每个段落后面添加换行
          text += block.text + '\r\n\r\n'
        }
      }
      for (const link of linkTexts) {
        const links = this.getTextLinks(link)
        result.links.text = result.links.text.concat(links)
        result.links.fileId = this.createFileId()
      }

      if (settings.saveText && text) {
        result.links.text.push(text)
      }

      // 保存图片资源
      for (const block of data.body.blocks) {
        if (block.type === 'image') {
          const imageData = data.body.imageMap[block.imageId]
          if (!imageData) {
            continue
          }
          index++
          const resource = this.getImageData(imageData, index)
          resource !== null && result.files.push(resource)
        }
      }

      // 保存 file 资源
      for (const block of data.body.blocks) {
        if (block.type === 'file') {
          const fileData = data.body.fileMap[block.fileId]
          if (!fileData) {
            continue
          }
          index++
          const resource = this.getFileData(fileData, index)
          resource !== null && result.files.push(resource)
        }
      }

      // 保存嵌入的资源，只能保存到文本
      const embedDataArr: EmbedDataArr = []
      for (const [id, embedData] of Object.entries(data.body.embedMap)) {
        embedDataArr.push([embedData.serviceProvider, embedData.contentId])
      }
      const embedLinks = this.getEmbedLinks(embedDataArr, data.id)
      result.links.text = result.links.text.concat(embedLinks)
      result.links.fileId = this.createFileId()

      // 保存嵌入的 URL，只能保存到文本
      if (settings.saveLink) {
        const urlArr: string[] = []
        for (const val of Object.values(data.body.urlEmbedMap)) {
          if (val.type === 'default') {
            urlArr.push(val.url)
          } else if (val.type === 'html' || val.type === 'html.card') {
            // 尝试从 html 代码中提取 url
            const testURL = val.html.match('iframe src="(http.*)"')
            if (testURL && testURL.length > 1) {
              let url = testURL[1]
              // 对 Google Drive 的链接进行特殊处理，将其从转换后的嵌入网址还原为原始网址
              if (url.includes('preview?usp=embed_googleplus')) {
                url = url.replace(
                  'preview?usp=embed_googleplus',
                  'edit?usp=drive_link'
                )
              }
              if (url.includes('embeddedfolderview?id=')) {
                url = url
                  .replace('embeddedfolderview?id=', 'drive/folders/')
                  .replace('#list', '?usp=drive_link')
              }
              urlArr.push(url)
            } else {
              urlArr.push(val.html)
            }
          }
        }
        if (urlArr.length > 0) {
          result.links.text = result.links.text.concat(urlArr.join('\n\n'))
          result.links.fileId = this.createFileId()
        }
      }
    }

    // 提取 image 投稿的资源
    if (data.type === 'image') {
      // 保存图片资源
      for (const imageData of data.body.images) {
        if (!imageData) {
          continue
        }
        index++
        const resource = this.getImageData(imageData, index)
        resource !== null && result.files.push(resource)
      }
    }

    // 提取 entry 投稿的图片资源
    // 不知道此类型投稿中是否有其他类型的资源
    if (data.type === 'entry') {
      const LinkList = data.body.html.match(/<a.*?>/g)
      if (LinkList) {
        for (const a of LinkList) {
          const matchUrl = a.match('https.*(jpeg|jpg|png|gif|bmp)')
          if (!matchUrl) {
            continue
          }
          // 组合出 imageData，添加到结果中
          index++
          const url = matchUrl[0]
          const { name, ext } = this.getUrlNameAndExt(url)

          let width = 0
          const widthMatch = a.match(/width="(\d*?)"/)
          if (widthMatch && widthMatch.length > 1) {
            width = parseInt(widthMatch[1])
          }

          let height = 0
          const heightMatch = a.match(/height="(\d*?)"/)
          if (heightMatch && heightMatch.length > 1) {
            height = parseInt(heightMatch[1])
          }

          const imageData: ImageData = {
            id: name,
            extension: ext,
            originalUrl: url,
            thumbnailUrl: url,
            width: width,
            height: height,
          }

          const resource = this.getImageData(imageData, index)
          resource !== null && result.files.push(resource)
        }
      }
    }

    // 提取 file 投稿的资源
    if (data.type === 'file') {
      // 保存 file 资源
      for (const fileData of data.body.files) {
        if (!fileData) {
          continue
        }
        index++
        const resource = this.getFileData(fileData, index)
        resource !== null && result.files.push(resource)
      }
    }

    // 提取 video 投稿的资源
    // video 数据保存到文本
    if (data.type === 'video') {
      const video = data.body.video
      const embedDataArr: EmbedDataArr = [
        [video.serviceProvider, video.videoId],
      ]
      const embedLinks = this.getEmbedLinks(embedDataArr, data.id)
      result.links.text = result.links.text.concat(embedLinks)
      result.links.fileId = this.createFileId()
    }

    store.addResult(result)
  }

  private getImageData(imageData: ImageData, index: number): FileResult | null {
    if (
      filter.check({
        ext: imageData.extension,
      })
    ) {
      return {
        fileId: imageData.id,
        name: imageData.id,
        ext: imageData.extension,
        size: null,
        index,
        url: imageData.originalUrl,
        retryUrl: imageData.thumbnailUrl,
      }
    }

    return null
  }

  private getFileData(fileData: FileData, index: number): FileResult | null {
    if (
      filter.check({
        ext: fileData.extension,
      })
    ) {
      return {
        fileId: fileData.id,
        name: fileData.name,
        ext: fileData.extension,
        size: fileData.size,
        index,
        url: fileData.url,
        retryUrl: null,
      }
    }

    return null
  }

  // 从文本里提取链接
  private getTextLinks(text: string) {
    const links: string[] = []

    if (!settings.saveLink) {
      return links
    }

    // 一个段落里可能包含多个链接（啊好麻烦），所以用换行符来尝试分割一下
    const textArray = text.split('\n')
    const Reg = /http[s]*:\/\/[\w=\?\.\/&\-\#\!\%]+/g
    for (const str of textArray) {
      const match = Reg.exec(str)
      Reg.lastIndex = 0
      if (match && match.length > 0) {
        for (const link of match) {
          links.push(link)
        }
      }
    }

    return links
  }

  // 从嵌入的资源里，获取资源的原网址
  private getEmbedLinks(dataArr: EmbedDataArr, postId: string) {
    const links: string[] = []

    if (!settings.saveLink) {
      return links
    }

    for (const data of dataArr) {
      const [serviceProvider, contentId] = data
      let link = this.providerDict[serviceProvider] + contentId
      // 谷歌表单需要在链接后面添加特定后缀
      if (serviceProvider === 'google_forms') {
        link = link + '/viewform'
      }
      links.push(link)
    }

    return links
  }

  // 下载器自己生成的 txt 文件没有 id，所以这里需要自己给它生成一个 id
  // 使用时间戳并不保险，因为有时候代码执行太快，会生成重复的时间戳。所以后面加上随机字符
  private createFileId() {
    return (
      new Date().getTime().toString() +
      Math.random().toString(16).replace('.', '')
    )
  }

  // 传入文件 url，提取文件名和扩展名
  private getUrlNameAndExt(url: string): {
    name: string
    ext: string
  } {
    const split = url.split('/')
    const fileName = split[split.length - 1]
    const name = fileName.split('.')[0]
    const ext = fileName.split('.')[1]
    return {
      name,
      ext,
    }
  }
}

const saveData = new SaveData()
export { saveData }
